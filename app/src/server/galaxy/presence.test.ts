/**
 * Presence broadcast + activity derivation tests — TASK-36.
 *
 * Covers the server-side TASK-36 acceptance criteria:
 *
 *   - `buildPresencePayload` derives `state` from the player's bound
 *     entity (character → "onfoot", docked ship → "docked", else
 *     "flying").
 *   - `derivePlayerActivity` returns the right tag for each shape.
 *   - `firePresenceBroadcast` re-fires after a successful disembark
 *     or re-entry so every client in the system sees the icon swap.
 *   - The roster still includes the player after they disembark
 *     (the presence entry stays — only the `state` tag changes).
 *   - Two clients in the same system, one docked + one on-foot,
 *     produce a 2-entry roster with distinct `state` values.
 */
import { describe, expect, it } from "vitest";

import { generateStars } from "@shared/galaxy/stars.js";

import { buildShardContext } from "./system-data.js";
import {
  buildPresencePayload,
  derivePlayerActivity,
  firePresenceBroadcast,
  type PresenceBroadcaster,
} from "./presence.js";
import { makeCharacterEntity, makeEntityId, makePlayerEntity } from "../shard/entity.js";
import { createShard, spawnShip } from "../shard/index.js";
import type { ShardConnection, SimEntity } from "../shard/types.js";

import type { PayloadFor } from "@shared/protocol/index.js";

const SEED = "PRESENCE-TASK-36-TEST-SEED";
const ZERO_VEL = { x: 0, y: 0, z: 0 };
const ZERO_QUAT = { x: 0, y: 0, z: 0, w: 1 };

function makeShard(): {
  shard: ReturnType<typeof createShard>;
  ship1: SimEntity;
  ship2: SimEntity;
} {
  const stars = generateStars(SEED, 4);
  const ctx = buildShardContext({
    seed: SEED,
    starCount: 4,
    systemId: stars[0]!.id,
  });
  const shard = createShard({
    systemId: ctx.system.systemId,
    context: ctx,
    send: () => {},
    broadcast: () => {},
    autoStart: false,
  });
  const ship1 = spawnShip(shard, {
    shipId: "ship-1",
    playerId: "p1",
    callsign: "Pilot1",
    classId: "scout",
    hull: 100,
    shields: 100,
    pos: { x: 0, y: 0, z: 0 },
    vel: ZERO_VEL,
    quat: ZERO_QUAT,
    regime: "space",
    originPlanetId: null,
    onPad: null,
    bindConnId: "c1",
  });
  const conn1: ShardConnection = {
    connId: "c1",
    playerId: "p1",
    callsign: "Pilot1",
    shipId: "ship-1",
    entityId: ship1.id,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  shard.connections.set("c1", conn1);

  const ship2 = spawnShip(shard, {
    shipId: "ship-2",
    playerId: "p2",
    callsign: "Pilot2",
    classId: "scout",
    hull: 100,
    shields: 100,
    pos: { x: 10, y: 0, z: 0 },
    vel: ZERO_VEL,
    quat: ZERO_QUAT,
    regime: "space",
    originPlanetId: null,
    onPad: null,
    bindConnId: "c2",
  });
  const conn2: ShardConnection = {
    connId: "c2",
    playerId: "p2",
    callsign: "Pilot2",
    shipId: "ship-2",
    entityId: ship2.id,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  shard.connections.set("c2", conn2);
  return { shard, ship1, ship2 };
}

describe("presence: TASK-36 activity derivation", () => {
  it("returns 'flying' when the player has a ship entity with no pad", () => {
    const { shard } = makeShard();
    expect(derivePlayerActivity(shard, "p1")).toBe("flying");
  });

  it("returns 'docked' when the ship's onPad is non-null", () => {
    const { shard } = makeShard();
    shard.entities.get(makeEntityId("ship-1"))!.onPad = "pad-x-y";
    expect(derivePlayerActivity(shard, "p1")).toBe("docked");
  });

  it("returns 'onfoot' when a character entity is bound to the player", () => {
    const { shard } = makeShard();
    // Mint a character entity for p1. The character's kind
    // determines the activity regardless of whether the ship
    // is also still parked on a pad.
    const charId = "char:p1";
    const character = makeCharacterEntity({
      id: charId,
      playerId: "p1",
      callsign: "Pilot1",
      shipId: "ship-1",
      pos: { x: 0, y: 0, z: 0 },
      quat: ZERO_QUAT,
      regime: "surface",
    });
    shard.entities.set(charId, character);
    expect(derivePlayerActivity(shard, "p1")).toBe("onfoot");
  });

  it("returns 'flying' when the player is unknown to the shard", () => {
    const { shard } = makeShard();
    expect(derivePlayerActivity(shard, "p-unknown")).toBe("flying");
  });

  it("character wins over a docked ship (disembark overrides pad state)", () => {
    const { shard } = makeShard();
    // Player 1 is docked (ship on pad) AND has disembarked a character.
    shard.entities.get(makeEntityId("ship-1"))!.onPad = "pad-x-y";
    const charId = "char:p1";
    const character = makeCharacterEntity({
      id: charId,
      playerId: "p1",
      callsign: "Pilot1",
      shipId: "ship-1",
      pos: { x: 0, y: 0, z: 0 },
      quat: ZERO_QUAT,
      regime: "surface",
    });
    shard.entities.set(charId, character);
    // The character is authoritative — PlayerList shows the walking
    // icon even though the ship is technically still docked.
    expect(derivePlayerActivity(shard, "p1")).toBe("onfoot");
  });
});

describe("presence: TASK-36 buildPresencePayload", () => {
  it("emits one entry per connection with the right state", () => {
    const { shard } = makeShard();
    shard.entities.get(makeEntityId("ship-2"))!.onPad = "pad-x-y";
    const payload = buildPresencePayload(shard);
    const p1 = payload.players.find((p) => p.playerId === "p1");
    const p2 = payload.players.find((p) => p.playerId === "p2");
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1?.state).toBe("flying");
    expect(p2?.state).toBe("docked");
  });

  it("includes shipId from the connection, not from the entity", () => {
    const { shard } = makeShard();
    const payload = buildPresencePayload(shard);
    const p1 = payload.players.find((p) => p.playerId === "p1")!;
    expect(p1.shipId).toBe("ship-1");
  });

  it("systemId comes from the shard, not the connection", () => {
    const { shard } = makeShard();
    const payload = buildPresencePayload(shard);
    expect(payload.systemId).toBe(shard.systemId);
  });
});

describe("presence: TASK-36 firePresenceBroadcast", () => {
  it("fires once per call (no broadcaster = no-op)", () => {
    const { shard } = makeShard();
    // No throw, no return — the no-broadcaster path is the unit-test
    // default.
    expect(() => firePresenceBroadcast(undefined, shard)).not.toThrow();
  });

  it("forwards the canonical payload to the broadcaster", () => {
    const { shard } = makeShard();
    const calls: Array<{ systemId: string; payload: PayloadFor<"presence"> }> = [];
    const broadcaster: PresenceBroadcaster = (systemId, payload) => {
      calls.push({ systemId, payload });
    };
    firePresenceBroadcast(broadcaster, shard);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.systemId).toBe(shard.systemId);
    // The payload carries both connections (2-entry roster).
    expect(calls[0]!.payload.players).toHaveLength(2);
  });

  it("emits the right state per connection when re-fired after disembark", () => {
    const { shard } = makeShard();
    const calls: Array<{ systemId: string; payload: PayloadFor<"presence"> }> = [];
    const broadcaster: PresenceBroadcaster = (systemId, payload) => {
      calls.push({ systemId, payload });
    };
    // Pre-disembark: p1 is "flying".
    firePresenceBroadcast(broadcaster, shard);
    // Disembark p1 by adding a character entity.
    const charId = "char:p1";
    const character = makeCharacterEntity({
      id: charId,
      playerId: "p1",
      callsign: "Pilot1",
      shipId: "ship-1",
      pos: { x: 0, y: 0, z: 0 },
      quat: ZERO_QUAT,
      regime: "surface",
    });
    shard.entities.set(charId, character);
    // Post-disembark: p1 is "onfoot".
    firePresenceBroadcast(broadcaster, shard);
    expect(calls).toHaveLength(2);
    const first = calls[0]!.payload.players.find((p) => p.playerId === "p1");
    const second = calls[1]!.payload.players.find((p) => p.playerId === "p1");
    expect(first?.state).toBe("flying");
    expect(second?.state).toBe("onfoot");
  });

  it("removes the character entity to re-derive 'flying' (re-entry)", () => {
    const { shard } = makeShard();
    const calls: Array<{ systemId: string; payload: PayloadFor<"presence"> }> = [];
    const broadcaster: PresenceBroadcaster = (systemId, payload) => {
      calls.push({ systemId, payload });
    };
    const charId = "char:p1";
    const character = makeCharacterEntity({
      id: charId,
      playerId: "p1",
      callsign: "Pilot1",
      shipId: "ship-1",
      pos: { x: 0, y: 0, z: 0 },
      quat: ZERO_QUAT,
      regime: "surface",
    });
    shard.entities.set(charId, character);
    firePresenceBroadcast(broadcaster, shard);
    // Re-entry: character despawns; the ship stays parked (or flying).
    shard.entities.delete(charId);
    firePresenceBroadcast(broadcaster, shard);
    const states = calls.map((c) => c.payload.players.find((p) => p.playerId === "p1")?.state);
    expect(states).toEqual(["onfoot", "flying"]);
  });
});

// Touch the import to satisfy the no-unused-vars lint when the
// surface is reduced. The constants are referenced through the
// helper functions above.
const _unused_makePlayerEntity = makePlayerEntity;
void _unused_makePlayerEntity;
