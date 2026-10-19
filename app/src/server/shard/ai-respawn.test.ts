/**
 * Rogue-AI respawn lifecycle tests — TASK-45.
 *
 * Verifies:
 *   - `scheduleAiRespawn` removes the live entity, broadcasts
 *     `combat_event { kind: 'destroyed' }`, and registers a
 *     timer keyed by `aiId`.
 *   - `advanceAiRespawns` re-mints the entity once the timer
 *     elapses and removes the entry (so the registry stays
 *     bounded).
 *   - The cancel + clear APIs handle reaped shards cleanly.
 *   - `applyCombatDamage` special-cases AI ships (no wreck,
 *     respawn timer instead).
 *
 * Uses the recorder shard pattern from `combat.test.ts`. We
 * drive `advanceAiRespawns` directly rather than going
 * through the sim tick because the respawn delay is 120 s
 * (much longer than a normal vitest run).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceAiRespawns,
  cancelAiRespawn,
  clearAiRespawns,
  scheduleAiRespawn,
} from "./ai-respawn.js";
import {
  addConnection,
  createShard,
  removeEntity,
  spawnAiShip,
  spawnShip,
  type Shard,
  type ShardConnection,
} from "./index.js";
import type { ShardSystemContext } from "./types.js";
import { applyCombatDamage, aiSource, playerSource } from "./combat.js";
import { entityToWire } from "./entity.js";
import type { ProtocolEntityState } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Recorder shard (mirrors combat.test.ts)
// ---------------------------------------------------------------------------

function makeContext(): ShardSystemContext {
  return {
    starId: "star-AI-TEST",
    system: {
      systemId: "test-system-ai",
      name: "TestSystem-AI",
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
}

function makeRecorderShard(): Recorder {
  const sent: Array<{ connId: string; frame: unknown }> = [];
  const shard = createShard({
    systemId: "test-system-ai",
    context: makeContext(),
    send: (connId, frame) => {
      sent.push({ connId, frame });
    },
    broadcast: () => undefined,
    autoStart: false,
  });
  return { shard, sent };
}

function combatEventsSent(recorder: Recorder): Array<{
  kind: string;
  target: string;
  tick: number;
  source?: { kind: string; id: string };
  attacker?: string;
}> {
  return recorder.sent
    .filter((s) => (s.frame as { type?: string }).type === "combat_event")
    .map(
      (s) =>
        (s.frame as { payload: unknown }).payload as {
          kind: string;
          target: string;
          tick: number;
          source?: { kind: string; id: string };
          attacker?: string;
        },
    );
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

// ---------------------------------------------------------------------------
// scheduleAiRespawn — happy path
// ---------------------------------------------------------------------------

describe("scheduleAiRespawn", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard();
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("removes the live entity and registers a timer keyed by aiId", () => {
    const ai = spawnAiShip(recorder.shard, {
      id: "ai-1",
      classId: "scout",
      pos: { x: 100, y: 0, z: 100 },
      callsign: "RAVEN",
    });
    expect(recorder.shard.entities.has("ai-1")).toBe(true);

    const entry = scheduleAiRespawn(recorder.shard, {
      aiId: ai.id,
      spawnPos: ai.pos,
      classId: "scout",
      callsign: ai.callsign ?? "RAVEN",
      respawnAtMs: 1_000_000,
    });

    expect(recorder.shard.entities.has("ai-1")).toBe(false);
    expect(entry.aiId).toBe("ai-1");
    expect(entry.callsign).toBe("RAVEN");
    expect(recorder.shard.aiRespawns.get("ai-1")).toEqual(entry);
  });

  it("broadcasts `combat_event { kind: 'destroyed' }`", () => {
    spawnAiShip(recorder.shard, {
      id: "ai-2",
      classId: "scout",
      pos: { x: 0, y: 0, z: 0 },
      callsign: "WRAITH",
    });

    // Add a connection so the broadcast has a recipient path
    // (broadcastCombatEvent walks shard.connections).
    addConnection(recorder.shard, makeConnection({ connId: "conn-1" }));

    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-2",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      callsign: "WRAITH",
      respawnAtMs: 2_000_000,
    });

    const events = combatEventsSent(recorder);
    expect(events.find((e) => e.kind === "destroyed" && e.target === "ai-2")).toBeDefined();
  });

  it("is idempotent on a duplicate scheduleAiRespawn call", () => {
    spawnAiShip(recorder.shard, {
      id: "ai-3",
      classId: "scout",
      pos: { x: 0, y: 0, z: 0 },
      callsign: "VAMPIRE",
    });
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-3",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      callsign: "VAMPIRE",
      respawnAtMs: 1_000,
    });
    // Second call with a later `respawnAtMs` replaces the entry.
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-3",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      callsign: "VAMPIRE",
      respawnAtMs: 5_000,
    });
    expect(recorder.shard.aiRespawns.get("ai-3")?.respawnAtMs).toBe(5_000);
    expect(recorder.shard.aiRespawns.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// advanceAiRespawns — the 120 s server timer
// ---------------------------------------------------------------------------

describe("advanceAiRespawns", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard();
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("does nothing when no timers have elapsed", () => {
    spawnAiShip(recorder.shard, {
      id: "ai-a",
      classId: "scout",
      pos: { x: 0, y: 0, z: 0 },
      callsign: "PHANTOM",
    });
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-a",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      callsign: "PHANTOM",
      respawnAtMs: 1_000_000,
    });
    advanceAiRespawns(recorder.shard, { nowMs: 999_999 });
    expect(recorder.shard.aiRespawns.size).toBe(1);
    expect(recorder.shard.entities.has("ai-a")).toBe(false);
  });

  it("re-mints the entity and clears the entry when the timer elapses", () => {
    spawnAiShip(recorder.shard, {
      id: "ai-b",
      classId: "interceptor",
      pos: { x: 500, y: 0, z: 500 },
      callsign: "REAPER",
    });
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-b",
      spawnPos: { x: 500, y: 0, z: 500 },
      classId: "interceptor",
      callsign: "REAPER",
      respawnAtMs: 1_000_000,
    });
    const respawned = advanceAiRespawns(recorder.shard, { nowMs: 1_000_001 });
    expect(respawned).toEqual(["ai-b"]);
    expect(recorder.shard.aiRespawns.size).toBe(0);
    const entity = recorder.shard.entities.get("ai-b");
    expect(entity?.id).toBe("ai-b");
    expect(entity?.kind).toBe("ai");
    expect(entity?.callsign).toBe("REAPER");
    expect(entity?.pos.x).toBe(500);
    expect(entity?.pos.z).toBe(500);
    expect(entity?.aiSpawnPos?.x).toBe(500);
  });

  it("re-mints multiple entities in one pass when timers batch-elapse", () => {
    spawnAiShip(recorder.shard, {
      id: "ai-c",
      classId: "scout",
      pos: { x: 0, y: 0, z: 0 },
      callsign: "COMET",
    });
    spawnAiShip(recorder.shard, {
      id: "ai-d",
      classId: "freighter",
      pos: { x: 100, y: 0, z: 0 },
      callsign: "AURORA",
    });
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-c",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      callsign: "COMET",
      respawnAtMs: 500,
    });
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-d",
      spawnPos: { x: 100, y: 0, z: 0 },
      classId: "freighter",
      callsign: "AURORA",
      respawnAtMs: 1_500,
    });
    const respawned = advanceAiRespawns(recorder.shard, { nowMs: 2_000 });
    expect(new Set(respawned)).toEqual(new Set(["ai-c", "ai-d"]));
    expect(recorder.shard.aiRespawns.size).toBe(0);
    expect(recorder.shard.entities.size).toBe(2);
  });

  it("re-entrant kill within the same tick: kill the freshly-minted entity", () => {
    spawnAiShip(recorder.shard, {
      id: "ai-e",
      classId: "scout",
      pos: { x: 0, y: 0, z: 0 },
      callsign: "TEMPEST",
    });
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-e",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      callsign: "TEMPEST",
      respawnAtMs: 100,
    });
    advanceAiRespawns(recorder.shard, { nowMs: 200 });
    expect(recorder.shard.entities.has("ai-e")).toBe(true);
    // Re-schedule and make sure the registry handles a second
    // cycle without leaking the first.
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-e",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      callsign: "TEMPEST",
      respawnAtMs: 300,
    });
    advanceAiRespawns(recorder.shard, { nowMs: 400 });
    expect(recorder.shard.aiRespawns.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cancelAiRespawn + clearAiRespawns — reap path
// ---------------------------------------------------------------------------

describe("cancelAiRespawn / clearAiRespawns", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard();
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("cancelAiRespawn removes a single entry and is idempotent", () => {
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-x",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      callsign: "GHOST",
      respawnAtMs: 999_999,
    });
    expect(cancelAiRespawn(recorder.shard, "ai-x")).toBe(true);
    expect(cancelAiRespawn(recorder.shard, "ai-x")).toBe(false);
    expect(recorder.shard.aiRespawns.size).toBe(0);
  });

  it("clearAiRespawns drops every outstanding entry", () => {
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-y1",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      callsign: "KESTREL",
      respawnAtMs: 1_000,
    });
    scheduleAiRespawn(recorder.shard, {
      aiId: "ai-y2",
      spawnPos: { x: 0, y: 0, z: 0 },
      classId: "freighter",
      callsign: "TEMPEST",
      respawnAtMs: 2_000,
    });
    const cleared = clearAiRespawns(recorder.shard);
    expect(cleared).toBe(2);
    expect(recorder.shard.aiRespawns.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyCombatDamage — AI special case (no wreck, respawn instead)
// ---------------------------------------------------------------------------

describe("applyCombatDamage — AI special case (TASK-45)", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard();
    addConnection(recorder.shard, makeConnection({ connId: "conn-p" }));
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("AI ship destruction → no wreck, respawn timer set", () => {
    const ai = spawnAiShip(recorder.shard, {
      id: "ai-fighter-1",
      classId: "scout",
      pos: { x: 1_000, y: 0, z: 0 },
      callsign: "COMET",
    });
    const result = applyCombatDamage({
      shard: recorder.shard,
      targetId: ai.id,
      amount: 9999,
      source: playerSource("HERO"),
      tick: 1,
      sourceEntityId: "entity:player-1",
      weapon: "laser",
    });
    expect(result.destroyed).toBe(true);
    expect(result.wreckSpawnedId).toBeNull();
    expect(recorder.shard.entities.has(ai.id)).toBe(false);
    expect(recorder.shard.entities.has(makeWreckIdFor(ai.id))).toBe(false);
    expect(recorder.shard.aiRespawns.has(ai.id)).toBe(true);
  });

  it("kills broadcast `kind: 'kill'` for player sources", () => {
    spawnAiShip(recorder.shard, {
      id: "ai-fighter-2",
      classId: "scout",
      pos: { x: 2_000, y: 0, z: 0 },
      callsign: "WRAITH",
    });
    applyCombatDamage({
      shard: recorder.shard,
      targetId: "ai-fighter-2",
      amount: 9999,
      source: playerSource("HERO"),
      tick: 1,
      sourceEntityId: "entity:player-1",
      weapon: "missile",
    });
    const events = combatEventsSent(recorder);
    expect(events.some((e) => e.kind === "destroyed" && e.target === "ai-fighter-2")).toBe(true);
    expect(events.some((e) => e.kind === "kill" && e.target === "ai-fighter-2")).toBe(true);
  });

  it("non-AI targets still spawn wrecks (regression check)", () => {
    spawnShip(recorder.shard, {
      shipId: "player-ship-x",
      playerId: "p-x",
      callsign: "VICTIM",
      classId: "scout",
      hull: 100,
      shields: 0,
      pos: { x: 0, y: 0, z: 0 },
    });
    const result = applyCombatDamage({
      shard: recorder.shard,
      targetId: "entity:player-ship-x",
      amount: 9999,
      source: aiSource("AI-OPP"),
      tick: 1,
    });
    expect(result.destroyed).toBe(true);
    expect(result.wreckSpawnedId).toBe("wreck:entity:player-ship-x");
    expect(recorder.shard.aiRespawns.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// wire shape — AI ships use `kind: 'ship'` with `ai: true`
// ---------------------------------------------------------------------------

describe("entityToWire — AI shape (TASK-45)", () => {
  let recorder: Recorder;
  beforeEach(() => {
    recorder = makeRecorderShard();
  });
  afterEach(() => {
    recorder.shard.shutdown();
  });

  it("AI ships render as `kind: 'ship'` with `ai: true`", () => {
    spawnAiShip(recorder.shard, {
      id: "ai-visible",
      classId: "scout",
      pos: { x: 0, y: 0, z: 0 },
      callsign: "OUTLAW",
    });
    // Read the wire shape by walking the registry directly.
    const entities: ProtocolEntityState[] = [];
    for (const e of recorder.shard.entities.values()) {
      entities.push(entityToWire(e));
    }
    const aiEntity = entities.find((e) => e.id === "ai-visible");
    expect(aiEntity).toBeDefined();
    expect(aiEntity?.kind).toBe("ship");
    expect(aiEntity?.ai).toBe(true);
    expect(aiEntity?.callsign).toBe("OUTLAW");
  });

  it("player ships do NOT carry the `ai` flag (undefined)", () => {
    spawnShip(recorder.shard, {
      shipId: "player-ship-y",
      playerId: "p-y",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    const entities: ProtocolEntityState[] = [];
    for (const e of recorder.shard.entities.values()) {
      entities.push(entityToWire(e));
    }
    const playerEntity = entities.find((e) => e.id === "entity:player-ship-y");
    expect(playerEntity?.kind).toBe("ship");
    expect(playerEntity?.ai).toBeUndefined();
  });
});

// Suppress lint for unused removal helper.
void removeEntity;

/** Local replica of `makeWreckId` so this test file is self-contained. */
function makeWreckIdFor(sourceEntityId: string): string {
  return `wreck:${sourceEntityId}`;
}

void makeWreckIdFor;
