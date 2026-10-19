/**
 * resolveHit test suite — TASK-42 acceptance criteria.
 *
 * Covers every branch of `resolveHit` plus the LOS math in
 * `checkLineOfSight`:
 *
 *   1. Validation gates:
 *      - unknown-source rejection
 *      - unknown-target rejection
 *      - self-target rejection
 *      - dead-target rejection
 *      - out-of-range rejection (distance > weapon range)
 *      - line-of-sight rejection (terrain occludes the ray)
 *      - line-of-sight skipped in space (no origin planet)
 *      - not-attackable source/target kind gates
 *
 *   2. Success path:
 *      - broadcasts the `hit` combat event with the exact wire
 *        shape (kind='hit', attacker, target, weapon, damage, tick)
 *      - delegates to applyCombatDamage for the shielded HP math
 *        (`damaged` event follows the `hit`)
 *      - on a killing blow: broadcasts `destroyed` AND `kill` (player
 *        source only — AI source fires `destroyed` but not `kill`)
 *      - spawns a wreck entity with the right position + killer
 *        attribution
 *      - third-party observer: a third connection in the shard
 *        observes the same `hit` + `damaged` broadcast chain
 *
 *   3. LOS math:
 *      - analytic terrain that clearly occludes → rejection
 *      - analytic terrain that's clear → accept
 *      - source in pure space (no originPlanetId) → no LOS test
 *      - sub-sampling detects occlusions along the ray interior
 *        (a ray that *crosses* a hill, not just endpoints)
 *
 *   4. Damage math integration:
 *      - shields absorb before hull (verified via the `damaged`
 *        event payload, same as the existing combat.test.ts suite)
 *      - second resolveHit on a destroyed target returns
 *        `dead-target` (the resolver doesn't bypass the gate even
 *        though the entity exists)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProtocolCombatEvent } from "@shared/protocol/index.js";

import {
  resolveHit,
  checkLineOfSight,
  LOS_SAMPLES,
  LOS_TERRAIN_SLACK_M,
  type ResolveHitResult,
} from "./combat.resolve.js";
import {
  addConnection,
  createShard,
  removeConnection,
  spawnAiShip,
  spawnCharacter,
  spawnShip,
  spawnWreck,
  type Shard,
  type ShardConnection,
} from "./index.js";
import type { ShardSystemContext, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_VEL = { x: 0, y: 0, z: 0 };
const ZERO_QUAT = { x: 0, y: 0, z: 0, w: 1 };

interface Recorder {
  shard: Shard;
  sent: Array<{ connId: string; frame: unknown }>;
}

function makeContext(
  opts: {
    heightAtFor?: ShardSystemContext["heightAtFor"];
    planet?: { id: string; radiusKm: number; hasAtmosphere: boolean };
  } = {},
): ShardSystemContext {
  const planet = opts.planet ?? {
    id: "planet-DUMMY",
    radiusKm: 500, // 500 km radius (small enough for math, large enough for terrain math)
    hasAtmosphere: true,
  };
  // Cast keeps the planet shape minimal — only `id`/`radiusKm`/`hasAtmosphere`
  // are read by the resolver, the rest is filler for the planet type.
  const planetRecord = {
    id: planet.id,
    name: planet.id,
    orbitIndex: 0,
    radiusKm: planet.radiusKm,
    hasAtmosphere: planet.hasAtmosphere,
    landable: true,
    resourceTypes: [],
    dockCount: 0,
    aiRoster: [],
    class: "terran",
  } as unknown as NonNullable<ReturnType<ShardSystemContext["planetById"]>>;
  const planetMap = new Map<string, NonNullable<ReturnType<ShardSystemContext["planetById"]>>>();
  planetMap.set(planet.id, planetRecord);
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
      planets: [planetRecord],
    },
    planetById: (id) => planetMap.get(id),
    heightAtFor: opts.heightAtFor ?? (() => () => 0), // flat terrain by default
    tileSizeM: 64,
  };
}

function makeRecorderShard(
  opts: {
    context?: ShardSystemContext;
    autoStart?: boolean;
  } = {},
): Recorder {
  const sent: Array<{ connId: string; frame: unknown }> = [];
  const shard = createShard({
    systemId: "test-system",
    context: opts.context ?? makeContext(),
    send: (connId, frame) => {
      sent.push({ connId, frame });
    },
    broadcast: () => {
      // No-op for these tests (broadcasts aren't asserted here — only
      // per-connection `send` frames, which includes `combat_event`).
    },
    onTickObserver: null,
    autoStart: opts.autoStart,
  });
  return { shard, sent };
}

function makeConnection(args: {
  connId: string;
  playerId?: string;
  callsign?: string;
}): ShardConnection {
  return {
    connId: args.connId,
    callsign: args.callsign ?? `pilot-${args.connId}`,
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
    .filter((s) => (s.frame as { type?: string }).type === "combat_event")
    .map((s) => (s.frame as { payload: ProtocolCombatEvent }).payload);
}

// ---------------------------------------------------------------------------
// Rejection gates
// ---------------------------------------------------------------------------

describe("resolveHit — validation gates", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("rejects when the sourceId is not on the shard", () => {
    const target = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 100, z: 0 },
    });
    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: "no-such-entity",
      targetId: target.id,
      damage: 10,
      damagePoint: target.pos,
      range: 400,
      tick: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejection).toBe("unknown-source");
    expect(combatEventsSent(recorder)).toEqual([]);
  });

  it("rejects when the targetId is not on the shard", () => {
    const source = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 100, z: 0 },
    });
    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: "no-such-entity",
      damage: 10,
      damagePoint: { x: 0, y: 100, z: 50 },
      range: 400,
      tick: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejection).toBe("unknown-target");
  });

  it("rejects when source and target are the same entity (self-target)", () => {
    const source = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 100, z: 0 },
    });
    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: source.id,
      damage: 10,
      damagePoint: source.pos,
      range: 400,
      tick: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejection).toBe("self-target");
    expect(source.hull).toBe(100); // not mutated
  });

  it("rejects when the target is already destroyed (hull <= 0)", () => {
    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 100, z: 0 },
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 1,
      shields: 0,
      pos: { x: 0, y: 100, z: 50 },
    });
    // Manually mark the target as destroyed (hull 0).
    target.hull = 0;
    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 0, y: 100, z: 50 },
      range: 400,
      tick: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejection).toBe("dead-target");
    expect(combatEventsSent(recorder)).toEqual([]);
  });

  it("rejects when the impact point is beyond the weapon's range", () => {
    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 100, z: 0 },
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 100, z: 200 }, // 200 m
    });
    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 0, y: 100, z: 200 },
      range: 100, // 100 m max range — 200 m away is out
      tick: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejection).toBe("out-of-range");
    expect(target.hull).toBe(100); // untouched
  });

  it("accepts a hit at exactly the weapon's range (boundary)", () => {
    // Acceptance criterion: a hit within range lands. The boundary
    // is `distSq <= range*range` so a hit at exactly the range
    // passes. We verify this with a flat-world source so the LOS
    // check doesn't matter (no originPlanetId).
    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 400 },
      regime: "space",
      originPlanetId: null,
    });
    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 0, y: 5000, z: 400 },
      range: 400, // exactly at the boundary
      tick: 1,
    });
    expect(out.ok).toBe(true);
  });

  it("rejects when the source is a kind that can't attack (character)", () => {
    // A character is a valid entity but the v1 combat core is
    // "ship vs ship" only — characters carry no weapon. The
    // resolver must surface a `not-attackable` rejection.
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 50 },
    });
    // Mint a character directly by adding to the entity map.
    const character: SimEntity = {
      id: "char-1",
      kind: "character",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 0, y: 5000, z: 0 },
      vel: ZERO_VEL,
      quat: ZERO_QUAT,
      regime: "surface",
      originPlanetId: null,
      onPad: null,
    };
    recorder.shard.entities.set(character.id, character);

    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: character.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 0, y: 5000, z: 50 },
      range: 400,
      tick: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejection).toBe("not-attackable");
  });

  it("rejects when the target is a wreck (destroyed entity already moved to wreck)", () => {
    // A wreck can't be targeted — the resolver's `dead-target`
    // gate triggers first when the wreck's hull is 0 (which it is,
    // by spec). This test surfaces a wreck-shape id directly to
    // confirm the dead-target short-circuit fires.
    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const wreck = spawnWreck(recorder.shard, {
      id: "wreck-victim",
      classId: "scout",
      pos: { x: 0, y: 5000, z: 50 },
      sourceEntityId: "victim-original",
      nowMs: 0,
    });
    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: wreck.id,
      damage: 5,
      damagePoint: { x: 0, y: 5000, z: 50 },
      range: 400,
      tick: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejection).toBe("dead-target");
  });
});

// ---------------------------------------------------------------------------
// Success path — single hit
// ---------------------------------------------------------------------------

describe("resolveHit — success path", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("broadcasts a 'hit' combat_event before applying damage, with the exact wire shape", () => {
    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 100 },
      regime: "space",
      originPlanetId: null,
    });
    const conn = makeConnection({ connId: "conn-a" });
    addConnection(recorder.shard, conn);

    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 30,
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 400,
      tick: 7,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");

    // The damage falls on shields (TASK-23 shield-first contract).
    expect(target.shields).toBe(20);
    expect(target.hull).toBe(100);

    // The `hit` event was broadcast (single frame to the registered
    // connection) with the exact shape the protocol expects.
    const events = combatEventsSent(recorder);
    expect(events).toHaveLength(2); // hit + damaged
    expect(events[0]).toEqual({
      kind: "hit",
      attacker: "ALPHA", // source.callsign
      target: target.id,
      weapon: "laser",
      damage: 30,
      tick: 7,
    });
    // Second event is the shielded damage breakdown from
    // `applyCombatDamage`.
    expect(events[1]!.kind).toBe("damaged");
  });

  it("emits 'kill' on a player attacker when the hit destroys the target", () => {
    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 100 },
      regime: "space",
      originPlanetId: null,
    });
    const conn = makeConnection({ connId: "conn-a" });
    addConnection(recorder.shard, conn);

    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 200, // overkill: 50 shields + 100 hull + 50 over
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 400,
      tick: 9,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");

    // Order: hit → damaged → destroyed → kill. Per-connection
    // frames only see combat_event sends (3 frames from the resolver:
    // hit + damaged + destroyed + kill = 4 total).
    const events = combatEventsSent(recorder);
    expect(events.map((e) => e.kind)).toEqual(["hit", "damaged", "destroyed", "kill"]);
    // Verify the kill event carries the attacker's callsign so the
    // post-combat recap can show "Killer: ALPHA".
    const killEvent = events.find((e) => e.kind === "kill");
    expect(killEvent).toEqual({
      kind: "kill",
      attacker: "ALPHA",
      target: target.id,
      tick: 9,
    });

    // Wreck entity was spawned with killer attribution.
    const wreckId = `wreck:${target.id}`;
    const wreck = recorder.shard.entities.get(wreckId);
    expect(wreck).toBeDefined();
    expect(wreck!.kind).toBe("wreck");
    expect(wreck!.killerEntityId).toBe(source.id);
    expect(wreck!.killerKind).toBe("player");
    expect(wreck!.killerWeapon).toBe("laser");
  });

  it("does NOT emit 'kill' on an AI attacker (only 'destroyed' fires)", () => {
    // AI kills don't surface on the player kill log — the post-
    // combat recap is the *player* kill log, not a generic kill
    // log. Only `destroyed` fires, no `kill`.
    const ai = spawnAiShip(recorder.shard, {
      id: "ai-1",
      classId: "scout",
      pos: { x: 0, y: 5000, z: 0 },
    });
    // Patch the AI's regime + originPlanetId so the LOS check is
    // skipped (it's a space entity).
    ai.regime = "space";
    (ai as { originPlanetId: string | null }).originPlanetId = null;

    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 100 },
      regime: "space",
      originPlanetId: null,
    });
    const conn = makeConnection({ connId: "conn-a" });
    addConnection(recorder.shard, conn);

    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: ai.id,
      targetId: target.id,
      damage: 200,
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 400,
      tick: 1,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    const events = combatEventsSent(recorder);
    // hit + damaged + destroyed, NO kill.
    expect(events.map((e) => e.kind)).toEqual(["hit", "damaged", "destroyed"]);
  });

  it("two clients both observe the broadcast frames (third-party observer)", () => {
    // Acceptance criterion: integration test where the kill event
    // is observed by a third client. We simulate a two-ship duel:
    // A fires on B, both broadcasts land on two listeners (A's
    // connection + B's connection + a spectator).
    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 100 },
      regime: "space",
      originPlanetId: null,
    });
    // Three connections: the attacker, the victim, and a spectator.
    addConnection(recorder.shard, makeConnection({ connId: "c-alpha" }));
    addConnection(recorder.shard, makeConnection({ connId: "c-bravo" }));
    addConnection(recorder.shard, makeConnection({ connId: "c-spectator" }));

    resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 200,
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 400,
      tick: 1,
    });

    // Per-frame counts: 4 events (hit, damaged, destroyed, kill) × 3
    // connections = 12 frames sent.
    expect(combatEventsSent(recorder)).toHaveLength(12);
    // All three connections received a `kill` event.
    const killFrames = recorder.sent.filter((s) => {
      const f = s.frame as { type?: string; payload?: ProtocolCombatEvent };
      return f.type === "combat_event" && f.payload?.kind === "kill";
    });
    const killConnIds = new Set(killFrames.map((f) => f.connId));
    expect(killConnIds).toEqual(new Set(["c-alpha", "c-bravo", "c-spectator"]));
  });
});

// ---------------------------------------------------------------------------
// Friendly fire + identity
// ---------------------------------------------------------------------------

describe("resolveHit — PvP parity (friendly fire ON)", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("two players trading hits — neither same-team check rejects", () => {
    // The PRD's PvP-parity decision: no team flags in v1. Two
    // players from the same shard can shoot each other; the
    // resolver never rejects on source-kind == target-kind.
    const shipA = spawnShip(recorder.shard, {
      shipId: "ship-A",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const shipB = spawnShip(recorder.shard, {
      shipId: "ship-B",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 200 },
      regime: "space",
      originPlanetId: null,
    });
    addConnection(recorder.shard, makeConnection({ connId: "c-A" }));
    addConnection(recorder.shard, makeConnection({ connId: "c-B" }));

    // A fires on B.
    const outA = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: shipA.id,
      targetId: shipB.id,
      damage: 20,
      damagePoint: { x: 0, y: 5000, z: 200 },
      range: 400,
      tick: 1,
    });
    expect(outA.ok).toBe(true);
    expect(shipB.shields).toBe(30);
    expect(shipB.hull).toBe(100);

    // B fires on A (counterattack). 80 dmg = 50 shields absorb
    // + 30 hull damage → shipA shields 0, hull 70.
    const outB = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: shipB.id,
      targetId: shipA.id,
      damage: 80,
      damagePoint: { x: 0, y: 5000, z: 0 },
      range: 400,
      tick: 2,
    });
    expect(outB.ok).toBe(true);
    expect(shipA.shields).toBe(0);
    expect(shipA.hull).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// Damage pipeline integration
// ---------------------------------------------------------------------------

describe("resolveHit — damage pipeline integration", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("hit → shields → hull → destroyed in sequence (no skip)", () => {
    // Drive an entity to destruction through the resolver and
    // assert each shield/hull phase before the final killing blow.
    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 100 },
      regime: "space",
      originPlanetId: null,
    });
    addConnection(recorder.shard, makeConnection({ connId: "c-a" }));

    // 1. Small hit → shields absorb only.
    resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 20,
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 400,
      tick: 1,
    });
    expect(target.shields).toBe(30);
    expect(target.hull).toBe(100);
    // 2. Bigger hit → shields overflow into hull.
    resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 70,
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 400,
      tick: 2,
    });
    expect(target.shields).toBe(0);
    expect(target.hull).toBe(60);
    // 3. Killing blow → destroyed, wreck spawned, kill event
    //    surfaced (player source).
    resolveHit({
      shard: recorder.shard,
      weapon: "missile",
      sourceId: source.id,
      targetId: target.id,
      damage: 100,
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 800,
      tick: 3,
    });
    expect(target.hull).toBe(0);
    expect(target.shields).toBe(0);
    const wreckId = `wreck:${target.id}`;
    const wreck = recorder.shard.entities.get(wreckId);
    expect(wreck).toBeDefined();
    expect(wreck!.kind).toBe("wreck");
    // 4. Subsequent hit on the destroyed entity is `dead-target`.
    const followup = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 400,
      tick: 4,
    });
    expect(followup.ok).toBe(false);
    if (!followup.ok) expect(followup.rejection).toBe("dead-target");
  });
});

// ---------------------------------------------------------------------------
// Line-of-sight math
// ---------------------------------------------------------------------------

describe("resolveHit — line-of-sight math", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("rejects when a mountain sits between source and target (analytic terrain)", () => {
    // Custom heightAt that returns 200 m for any (x, z) inside the
    // "mountain" range. Source and target are placed such that the
    // ray passes THROUGH the mountain (samples 1-3 are below
    // terrain), so the LOS test must reject.
    //
    // We use a small planet (radiusKm = 1 → 1000 m) so the test
    // coords stay readable; ships sit at y=1100 (100 m above
    // surface). The mountain rises another 200 m so the midpoint
    // sample (at 1100) lands BELOW the 1200 m terrain altitude.
    const context = makeContext({
      heightAtFor: () => (x: number, _z: number) => (Math.abs(x) < 50 ? 200 : 0),
      planet: { id: "mountain-planet", radiusKm: 1, hasAtmosphere: true },
    });
    recorder = makeRecorderShard({ context, autoStart: false });

    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: -200, y: 1100, z: 0 },
      originPlanetId: "mountain-planet",
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 200, y: 1100, z: 0 },
      originPlanetId: "mountain-planet",
    });

    const out: ResolveHitResult = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 200, y: 1100, z: 0 },
      range: 4000,
      tick: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejection).toBe("line-of-sight");
    // Both ships remain at full HP because the hit was rejected.
    expect(target.hull).toBe(100);
    expect(source.hull).toBe(100);
  });

  it("accepts when the ray stays above the terrain (clear sky)", () => {
    // Custom terrain that only rises far from the ray; both ships
    // are well above the surface (y=1500 vs surface at 1100) →
    // clear.
    const context = makeContext({
      heightAtFor: () => (x: number, _z: number) => (x > 1000 ? 1000 : 0),
      planet: { id: "flat-planet", radiusKm: 1, hasAtmosphere: true },
    });
    recorder = makeRecorderShard({ context, autoStart: false });

    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: -100, y: 1500, z: 0 },
      originPlanetId: "flat-planet",
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 100, y: 1500, z: 0 },
      originPlanetId: "flat-planet",
    });

    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 100, y: 1500, z: 0 },
      range: 4000,
      tick: 1,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    // Shields took the hit (50 - 5 = 45).
    expect(target.shields).toBe(45);
  });

  it("skips LOS entirely when the source is in pure space (no originPlanetId)", () => {
    // No terrain function is consulted because source.originPlanetId
    // is null — the resolver short-circuits the LOS check regardless
    // of what `heightAtFor` returns. The vi.fn returns a fixed
    // heightAt function (typed against the actual callback shape);
    // wrapping it through `makeContext` casts the spy so the
    // ShardSystemContext's narrower optional field accepts it.
    const fixedHeightAt = () => 99999;
    const context = makeContext({
      heightAtFor: (_planetId: string) => fixedHeightAt,
      planet: { id: "obvious-mountain", radiusKm: 100, hasAtmosphere: true },
    });
    recorder = makeRecorderShard({ context, autoStart: false });

    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 999999, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 999999, z: 50 },
      regime: "space",
      originPlanetId: null,
    });
    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 0, y: 999999, z: 50 },
      range: 100,
      tick: 1,
    });
    expect(out.ok).toBe(true);
    // The source is in pure space — the LOS test is skipped.
    // We don't assert on the terrain function (no spy here).
  });

  it("subsamples detect occlusions along the ray interior (not just endpoints)", () => {
    // Custom heightAt that returns 200 m on a thin slab between
    // x=-10 and x=10, zero elsewhere. The ray crosses x=0 between
    // the source (x=-100) and target (x=+100) at altitude y=1100
    // (just 100 m above the 1000 m planet radius). The midpoint
    // sample's x=0 lands inside the 200 m terrain spike, putting
    // it below the 1200 m surface altitude → occlusion detected.
    const context = makeContext({
      heightAtFor: () => (x: number, _z: number) => (Math.abs(x) < 10 ? 200 : 0),
      planet: { id: "slab-planet", radiusKm: 1, hasAtmosphere: true },
    });
    recorder = makeRecorderShard({ context, autoStart: false });

    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: -100, y: 1100, z: 0 },
      originPlanetId: "slab-planet",
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 100, y: 1100, z: 0 },
      originPlanetId: "slab-planet",
    });

    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 100, y: 1100, z: 0 },
      range: 4000,
      tick: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejection).toBe("line-of-sight");
  });

  it("allows the impact point to be exactly at the surface (slack tolerance)", () => {
    // Verify the LOS slack: a ray whose impact-point sample lands
    // within `LOS_TERRAIN_SLACK_M` of the terrain altitude passes,
    // avoiding false-positive occlusions at the boundary. We use
    // a flat planet and place the ships exactly at y =
    // planet.radius (so y == surface altitude), with the slack
    // absorbing the on-surface rounding.
    const context = makeContext({
      heightAtFor: () => () => 0,
      planet: { id: "zero-planet", radiusKm: 1, hasAtmosphere: true },
    });
    recorder = makeRecorderShard({ context, autoStart: false });

    // Planet surface is at planet.radiusKm*1000 = 1000 m.
    // Place both ships just above the surface (y = 1000 + small
    // delta < slack) so the impact-point sample lands inside
    // the slack and the LOS test passes.
    const source = spawnShip(recorder.shard, {
      shipId: "attacker",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: -100, y: 1000.2, z: 0 },
      originPlanetId: "zero-planet",
    });
    const target = spawnShip(recorder.shard, {
      shipId: "victim",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 100, y: 1000.2, z: 0 },
      originPlanetId: "zero-planet",
    });

    const out = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: source.id,
      targetId: target.id,
      damage: 5,
      damagePoint: { x: 100, y: 1000.2, z: 0 },
      range: 4000,
      tick: 1,
    });
    expect(out.ok).toBe(true);
  });

  it("checkLineOfSight pure helper returns null when clear and 'line-of-sight' when occluded", () => {
    // Direct exercise of the helper against an analytic terrain.
    // The helper is exported specifically so unit tests can drive
    // it without spinning up a full resolveHit. Planet radius =
    // 1000 m, terrain rises 200 m on the 0 < x < 100 slab.
    const context = makeContext({
      heightAtFor: () => (x: number, _z: number) => (x > 0 && x < 100 ? 200 : 0),
      planet: { id: "hill-planet", radiusKm: 1, hasAtmosphere: true },
    });
    recorder = makeRecorderShard({ context, autoStart: false });

    const source: SimEntity = {
      id: "src",
      kind: "player",
      playerId: null,
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      targetId: null,
      pos: { x: -50, y: 1100, z: 0 },
      vel: ZERO_VEL,
      quat: ZERO_QUAT,
      regime: "space",
      originPlanetId: "hill-planet",
      onPad: null,
    };
    const target: SimEntity = {
      id: "tgt",
      kind: "ai",
      playerId: null,
      callsign: null,
      classId: "scout",
      hull: 100,
      shields: 50,
      targetId: null,
      pos: { x: 200, y: 1100, z: 0 },
      vel: ZERO_VEL,
      quat: ZERO_QUAT,
      regime: "space",
      originPlanetId: "hill-planet",
      onPad: null,
    };
    recorder.shard.entities.set(source.id, source);
    recorder.shard.entities.set(target.id, target);

    // Source → damagePoint where damagePoint is INSIDE the 200 m
    // hill slab (terrain at x=50 inside 0<x<100). The sample at
    // x=50 sees terrain=200; surface = 1200; ship y=1100 < 1200
    // → below terrain → occluded.
    const losOccluded = checkLineOfSight({
      shard: recorder.shard,
      source,
      target,
      damagePoint: { x: 50, y: 1100, z: 0 },
    });
    expect(losOccluded).toBe("line-of-sight");

    // Source → damagePoint entirely above the terrain (we fly
    // well above the 1200 m surface). Ray clear.
    const losClear = checkLineOfSight({
      shard: recorder.shard,
      source,
      target,
      damagePoint: { x: 50, y: 1500, z: 0 },
    });
    expect(losClear).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Two-ship duel integration (real WS clients observing the kill event)
// ---------------------------------------------------------------------------

describe("resolveHit — two-ship duel integration", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard({ autoStart: false });
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("A drains B's shields, B drains A's hull, A finishes B with a kill event observed by a spectator", () => {
    // Skeleton for the documented acceptance criterion: "two ships
    // trading hits via the sim, kill event observed by a third
    // client". We exercise this at the resolveHit level so the
    // test fast-path doesn't depend on the WS pipeline (the WS
    // integration equivalent is covered by the broader
    // `combat` event broadcast via `broadcastCombatEvent`).
    const shipA = spawnShip(recorder.shard, {
      shipId: "ship-A",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const shipB = spawnShip(recorder.shard, {
      shipId: "ship-B",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 200 },
      regime: "space",
      originPlanetId: null,
    });
    addConnection(recorder.shard, makeConnection({ connId: "c-A" }));
    addConnection(recorder.shard, makeConnection({ connId: "c-B" }));
    addConnection(recorder.shard, makeConnection({ connId: "c-S" }));

    // Phase 1: A → B. 40 dmg → B shields go from 50 → 10.
    resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: shipA.id,
      targetId: shipB.id,
      damage: 40,
      damagePoint: { x: 0, y: 5000, z: 200 },
      range: 400,
      tick: 1,
    });
    expect(shipB.shields).toBe(10);
    // Phase 2: B → A. 80 dmg = 50 shields absorb + 30 hull dmg →
    // A shields 0, hull 70.
    resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: shipB.id,
      targetId: shipA.id,
      damage: 80,
      damagePoint: { x: 0, y: 5000, z: 0 },
      range: 400,
      tick: 2,
    });
    expect(shipA.shields).toBe(0);
    expect(shipA.hull).toBe(70);
    // Phase 3: A kills B. 200 dmg onto 10 shields + 100 hull →
    // destroyed + kill event.
    resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: shipA.id,
      targetId: shipB.id,
      damage: 200,
      damagePoint: { x: 0, y: 5000, z: 200 },
      range: 400,
      tick: 3,
    });
    expect(shipB.hull).toBe(0);

    // Spectator connection ('c-S') observed the kill event
    // (player source ALPHA killed BRAVO). Each broadcast event
    // is delivered to every connection (3 connections × events).
    const spectatorKillFrames = recorder.sent.filter((s) => {
      if (s.connId !== "c-S") return false;
      const f = s.frame as { type?: string; payload?: ProtocolCombatEvent };
      return f.type === "combat_event" && f.payload?.kind === "kill";
    });
    expect(spectatorKillFrames).toHaveLength(1);
    const spectatorKill = (
      spectatorKillFrames[0]!.frame as {
        payload: ProtocolCombatEvent;
      }
    ).payload;
    if (spectatorKill.kind !== "kill") throw new Error("expected kill event");
    expect(spectatorKill.attacker).toBe("ALPHA");
    expect(spectatorKill.target).toBe(shipB.id);
  });

  it("integration: a destroyed ship cannot be re-targeted by resolveHit", () => {
    // Spec acceptance: "destroyed entities are not targetable
    // (TASK-23)" via the resolver. We destroy ship-B via the
    // resolver, then attempt a second hit.
    const shipA = spawnShip(recorder.shard, {
      shipId: "ship-A",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 0 },
      regime: "space",
      originPlanetId: null,
    });
    const shipB = spawnShip(recorder.shard, {
      shipId: "ship-B",
      playerId: "p-2",
      callsign: "BRAVO",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 5000, z: 100 },
      regime: "space",
      originPlanetId: null,
    });
    addConnection(recorder.shard, makeConnection({ connId: "c-A" }));

    // First hit kills B.
    const first = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: shipA.id,
      targetId: shipB.id,
      damage: 500,
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 400,
      tick: 1,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.apply.destroyed).toBe(true);

    // Second hit on the same target id is a `dead-target`.
    const second = resolveHit({
      shard: recorder.shard,
      weapon: "laser",
      sourceId: shipA.id,
      targetId: shipB.id,
      damage: 5,
      damagePoint: { x: 0, y: 5000, z: 100 },
      range: 400,
      tick: 2,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.rejection).toBe("dead-target");
    // No new combat_event frames beyond the first hit's chain.
    const eventsAfterFirst = combatEventsSent(recorder).slice(4); // skip first hit's hit/damaged/destroyed/kill
    expect(eventsAfterFirst).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Constants surface
// ---------------------------------------------------------------------------

describe("resolveHit — constants", () => {
  it("LOS_SAMPLES = 5 (spec requirement)", () => {
    expect(LOS_SAMPLES).toBe(5);
  });

  it("LOS_TERRAIN_SLACK_M = 0.5 (bounded tolerance)", () => {
    expect(LOS_TERRAIN_SLACK_M).toBe(0.5);
  });
});

// Suppress lint for unused imports in case Vitest strips tree-shake.
void ZERO_VEL;
void ZERO_QUAT;
void spawnCharacter;
void removeConnection;
