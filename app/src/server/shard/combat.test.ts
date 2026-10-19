/**
 * Combat pipeline integration tests — TASK-23 acceptance criteria.
 *
 * Covers the in-sim behaviour:
 *
 *   - Shield-first ordering flows through `applyCombatDamage` and
 *     mutates the live entity's hull + shields.
 *   - A destroyed ship:
 *       - has hull + shields clamped to zero,
 *       - is skipped by the integration loop (position / velocity
 *         do not change on subsequent ticks),
 *       - ignores player inputs (no acceleration, no turn),
 *       - spawns a wreck entity at the destroyed ship's final
 *         position + orientation,
 *       - remains non-targetable (no further `decay()` call mutates
 *         it; the wreck is a separate entity).
 *   - Double-destroy guard: a second `applyCombatDamage` against a
 *     destroyed target is a no-op (no second `destroyed` event).
 *   - Combat events: every `applyCombatDamage` call broadcasts a
 *     `combat_event` with `kind: 'damaged'` to every connection;
 *     the destroying call also broadcasts `kind: 'destroyed'`.
 *   - Wreck TTL: wrecks older than `WRECK_TTL_MS` are removed from
 *     the registry by the cleanup loop.
 *   - Wreck entity carries the class id + final position so the
 *     renderer can place the impostor (TASK-49).
 *
 * @see ./combat.ts for the implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyCombatDamage,
  broadcastCombatEvent,
  cleanupExpiredWrecks,
  WRECK_TTL_MS,
  WRECK_TTL_S,
  aiSource,
  playerSource,
} from "./combat.js";
import {
  addConnection,
  createShard,
  pushPlayerInput,
  removeConnection,
  simulateNTicks,
  spawnAiShip,
  spawnShip,
  spawnWreck,
  type Shard,
  type ShardConnection,
} from "./index.js";
import type { ShardSystemContext } from "./types.js";
import { SERVER_TICK_HZ, SNAPSHOT_EVERY_N_TICKS, TICK_S } from "./sim.js";
import type { ProtocolCombatEvent, ProtocolEntityState } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_VEL = { x: 0, y: 0, z: 0 };
const ZERO_QUAT = { x: 0, y: 0, z: 0, w: 1 };

function makeContext(): ShardSystemContext {
  return {
    starId: "star-DUMMY",
    system: {
      systemId: "test-system",
      name: "Test",
      star: {
        id: "star-test",
        name: "Test Star",
        class: "G",
        x: 0,
        y: 0,
        z: 0,
        systemCount: 1,
      },
      planets: [],
    },
    planetById: () => undefined,
    heightAtFor: () => undefined,
    tileSizeM: 64,
  };
}

interface Recorder {
  shard: Shard;
  sent: Array<{ connId: string; frame: unknown }>;
  broadcasts: Array<{
    tick: number;
    entities: ProtocolEntityState[];
    lastAppliedSeq: Readonly<Record<string, number>>;
  }>;
}

function makeRecorderShard(opts: { autoStart?: boolean } = {}): Recorder {
  const sent: Array<{ connId: string; frame: unknown }> = [];
  const broadcasts: Array<{
    tick: number;
    entities: ProtocolEntityState[];
    lastAppliedSeq: Readonly<Record<string, number>>;
  }> = [];
  const shard = createShard({
    systemId: "test-system",
    context: makeContext(),
    send: (connId, frame) => {
      sent.push({ connId, frame });
    },
    broadcast: (tick, entities, lastAppliedSeq) => {
      broadcasts.push({ tick, entities, lastAppliedSeq });
    },
    onTickObserver: null,
    autoStart: opts.autoStart,
  });
  return { shard, sent, broadcasts };
}

function makeConnection(args: { connId: string; playerId?: string }): ShardConnection {
  return {
    connId: args.connId,
    callsign: `pilot-${args.connId}`,
    playerId: args.playerId ?? `player-${args.connId}`,
    shipId: `ship-${args.connId}`,
    entityId: null,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
}

function combatEventsSent(recorder: Recorder): ProtocolCombatEvent[] {
  return recorder.sent
    .filter((s) => {
      const f = s.frame as { type?: string };
      return f.type === "combat_event";
    })
    .map((s) => (s.frame as { payload: ProtocolCombatEvent }).payload);
}

/** Drive one tick exactly; lets the test control wall-clock advancement. */
function driveOneTick(shard: Shard) {
  void shard.sim.tick();
}

// ---------------------------------------------------------------------------
// applyCombatDamage — shield-first through the live entity
// ---------------------------------------------------------------------------

describe("applyCombatDamage — shield-first ordering on the live entity", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("absorbs damage into shields without touching hull when amount < shields", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    const out = applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 30,
      source: playerSource("attacker"),
      tick: 1,
    });
    expect(out.shieldHit).toBe(30);
    expect(out.hullHit).toBe(0);
    expect(out.destroyed).toBe(false);
    expect(ship.hull).toBe(100);
    expect(ship.shields).toBe(20);
    expect(out.wreckSpawnedId).toBeNull();
  });

  it("overflows into hull when amount > shields", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    const out = applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 60,
      source: playerSource("attacker"),
      tick: 2,
    });
    expect(out.shieldHit).toBe(50);
    expect(out.hullHit).toBe(10);
    expect(out.destroyed).toBe(false);
    expect(ship.hull).toBe(90);
    expect(ship.shields).toBe(0);
  });

  it("destroys on a killing blow and spawns a wreck entity", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "CHARLIE",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 10, y: 20, z: 30 },
      quat: { x: 0, y: 0, z: 0.7071, w: 0.7071 },
    });
    const out = applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 150,
      source: aiSource("rogue-1"),
      tick: 3,
    });
    expect(out.destroyed).toBe(true);
    expect(out.wreckSpawnedId).toBe(`wreck:${ship.id}`);
    expect(out.destroyedTargetId).toBe(ship.id);

    // Wreck entity exists in the registry at the destroyed ship's
    // final position + orientation.
    const wreck = recorder.shard.entities.get(out.wreckSpawnedId!);
    expect(wreck).toBeDefined();
    expect(wreck!.kind).toBe("wreck");
    expect(wreck!.classId).toBe("scout");
    expect(wreck!.hull).toBe(0);
    expect(wreck!.shields).toBe(0);
    expect(wreck!.pos.x).toBe(10);
    expect(wreck!.pos.y).toBe(20);
    expect(wreck!.pos.z).toBe(30);
    // Quat preserved from the destroyed ship (renderer can re-pose).
    expect(wreck!.quat.z).toBeCloseTo(0.7071, 4);

    // Destroyed player's velocity is zeroed (no ghost drift).
    expect(ship.vel).toEqual({ x: 0, y: 0, z: 0 });
  });
});

// ---------------------------------------------------------------------------
// applyCombatDamage — combat event broadcast
// ---------------------------------------------------------------------------

describe("applyCombatDamage — combat_event broadcast", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("broadcasts a 'damaged' event to every connection in the shard", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    const connA = makeConnection({ connId: "conn-a" });
    const connB = makeConnection({ connId: "conn-b" });
    addConnection(recorder.shard, connA);
    addConnection(recorder.shard, connB);

    applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 30,
      source: playerSource("attacker"),
      tick: 7,
    });

    const events = combatEventsSent(recorder);
    expect(events).toHaveLength(2); // one per connection
    expect(events[0]).toEqual({
      kind: "damaged",
      target: ship.id,
      source: { kind: "player", id: "attacker" },
      amount: 30,
      shieldHit: 30,
      hullHit: 0,
      tick: 7,
    });
  });

  it("broadcasts a 'destroyed' event alongside the killing blow's 'damaged' event", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    const conn = makeConnection({ connId: "conn-a" });
    addConnection(recorder.shard, conn);

    applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 150,
      source: aiSource("rogue-1"),
      tick: 9,
    });

    const events = combatEventsSent(recorder);
    expect(events).toHaveLength(2);
    const damaged = events[0]!;
    expect(damaged.kind).toBe("damaged");
    if (damaged.kind === "damaged") {
      expect(damaged.shieldHit).toBe(50);
      expect(damaged.hullHit).toBe(100);
    }
    expect(events[1]).toEqual({
      kind: "destroyed",
      target: ship.id,
      source: { kind: "ai", id: "rogue-1" },
      tick: 9,
    });
  });

  it("does not broadcast anything when the target id is unknown", () => {
    const conn = makeConnection({ connId: "conn-a" });
    addConnection(recorder.shard, conn);
    const out = applyCombatDamage({
      shard: recorder.shard,
      targetId: "non-existent",
      amount: 1,
      source: playerSource("attacker"),
      tick: 1,
    });
    expect(out.hit).toBe(false);
    expect(combatEventsSent(recorder)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Destroyed ship integration behaviour
// ---------------------------------------------------------------------------

describe("destroyed ship — integration behaviour", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("a destroyed ship does not integrate on subsequent ticks", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "DELTA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    const conn = makeConnection({ connId: "conn-a" });
    addConnection(recorder.shard, conn);

    // Connect the player so inputs land on the entity.
    pushPlayerInput(recorder.shard, "conn-a", {
      seq: 1,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    // Tick once to assign the entity to the connection via the
    // pending input.
    void recorder.shard.sim.tick();

    // Apply enough damage to destroy the ship.
    applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 150,
      source: playerSource("attacker"),
      tick: 5,
    });
    // Snapshot post-damage position.
    const posAfterDeath = { x: ship.pos.x, y: ship.pos.y, z: ship.pos.z };

    // Enqueue another full-thrust input; the integration loop must
    // ignore it because `hull <= 0`.
    pushPlayerInput(recorder.shard, "conn-a", {
      seq: 2,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    for (let i = 0; i < 5; i++) {
      driveOneTick(recorder.shard);
    }

    expect(ship.pos.x).toBeCloseTo(posAfterDeath.x, 6);
    expect(ship.pos.y).toBeCloseTo(posAfterDeath.y, 6);
    expect(ship.pos.z).toBeCloseTo(posAfterDeath.z, 6);
  });

  it("a second applyCombatDamage on a destroyed target is a no-op", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "ECHO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    const conn = makeConnection({ connId: "conn-a" });
    addConnection(recorder.shard, conn);

    applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 150,
      source: playerSource("attacker"),
      tick: 1,
    });
    const eventsBefore = combatEventsSent(recorder).length;

    // Second hit, target already at hull 0.
    const out = applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 50,
      source: playerSource("attacker"),
      tick: 2,
    });
    expect(out.hit).toBe(false); // no work done — double-destroy guard
    expect(out.shieldHit).toBe(0);
    expect(out.hullHit).toBe(0);
    expect(combatEventsSent(recorder).length).toBe(eventsBefore); // no new events
  });
});

// ---------------------------------------------------------------------------
// Wreck TTL cleanup
// ---------------------------------------------------------------------------

describe("wreck TTL cleanup", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("removes wrecks older than WRECK_TTL_MS", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "FOXTROT",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 150,
      source: aiSource("rogue-1"),
      tick: 1,
      nowMs: 1_000_000,
    });
    const wreckId = `wreck:${ship.id}`;
    expect(recorder.shard.entities.has(wreckId)).toBe(true);

    // Step the wall clock past the TTL — cleanup should remove it.
    const removed = cleanupExpiredWrecks(recorder.shard, 1_000_000 + WRECK_TTL_MS + 1);
    expect(removed).toBe(1);
    expect(recorder.shard.entities.has(wreckId)).toBe(false);
  });

  it("leaves non-expired wrecks in place", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "GOLF",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    applyCombatDamage({
      shard: recorder.shard,
      targetId: ship.id,
      amount: 150,
      source: aiSource("rogue-1"),
      tick: 1,
      nowMs: 1_000_000,
    });
    const wreckId = `wreck:${ship.id}`;
    // Half-way through TTL — wreck still present.
    const removed = cleanupExpiredWrecks(recorder.shard, 1_000_000 + WRECK_TTL_MS / 2);
    expect(removed).toBe(0);
    expect(recorder.shard.entities.has(wreckId)).toBe(true);
  });

  it("leaves non-wreck entities untouched", () => {
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "HOTEL",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    const ai = spawnAiShip(recorder.shard, {
      id: "ai-1",
      classId: "scout",
      pos: { x: 100, y: 0, z: 0 },
    });
    const removed = cleanupExpiredWrecks(recorder.shard, Number.MAX_SAFE_INTEGER);
    expect(removed).toBe(0);
    expect(recorder.shard.entities.has(ship.id)).toBe(true);
    expect(recorder.shard.entities.has(ai.id)).toBe(true);
  });

  it("exposes WRECK_TTL_S = 600 (spec ceiling)", () => {
    expect(WRECK_TTL_S).toBe(600);
    expect(WRECK_TTL_MS).toBe(600_000);
  });
});

// ---------------------------------------------------------------------------
// spawnWreck (public helper)
// ---------------------------------------------------------------------------

describe("spawnWreck", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("creates a wreck entity at the given position with a default TTL", () => {
    const wreck = spawnWreck(recorder.shard, {
      id: "wreck-test",
      classId: "interceptor",
      pos: { x: 5, y: 5, z: 5 },
      nowMs: 2_000_000,
    });
    expect(wreck.kind).toBe("wreck");
    expect(wreck.classId).toBe("interceptor");
    expect(wreck.pos.x).toBe(5);
    expect(wreck.wreckExpiresAt).toBe(2_000_000 + WRECK_TTL_MS);
  });

  it("is idempotent on id", () => {
    const a = spawnWreck(recorder.shard, {
      id: "wreck-test",
      classId: "scout",
      pos: { x: 0, y: 0, z: 0 },
      nowMs: 0,
    });
    const b = spawnWreck(recorder.shard, {
      id: "wreck-test",
      classId: "interceptor",
      pos: { x: 99, y: 99, z: 99 },
      nowMs: 5_000,
    });
    expect(a).toBe(b);
    // Second call did NOT overwrite position or classId.
    expect(recorder.shard.entities.get("wreck-test")!.pos.x).toBe(0);
    expect(recorder.shard.entities.get("wreck-test")!.classId).toBe("scout");
  });
});

// ---------------------------------------------------------------------------
// broadcastCombatEvent (helper exposed for tests + downstream)
// ---------------------------------------------------------------------------

describe("broadcastCombatEvent", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("is exported and forwards frames via the shard's send hook", () => {
    const conn = makeConnection({ connId: "conn-a" });
    addConnection(recorder.shard, conn);
    broadcastCombatEvent(recorder.shard, {
      kind: "damaged",
      target: "ship-1",
      source: { kind: "player", id: "attacker" },
      amount: 5,
      shieldHit: 5,
      hullHit: 0,
      tick: 1,
    });
    const events = combatEventsSent(recorder);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("damaged");
  });
});

// ---------------------------------------------------------------------------
// Convenience source factories
// ---------------------------------------------------------------------------

describe("source factories", () => {
  it("playerSource returns {kind:'player', id}", () => {
    expect(playerSource("abc")).toEqual({ kind: "player", id: "abc" });
  });
  it("aiSource returns {kind:'ai', id}", () => {
    expect(aiSource("rogue-1")).toEqual({ kind: "ai", id: "rogue-1" });
  });
});

// Suppress lint for unused imports in case Vitest strips tree-shake.
void ZERO_VEL;
void ZERO_QUAT;
void SERVER_TICK_HZ;
void SNAPSHOT_EVERY_N_TICKS;
void TICK_S;
void simulateNTicks;
void removeConnection;
void vi;
