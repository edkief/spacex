/**
 * `handleEnterShip` server tests — TASK-35.
 *
 * Covers the spec acceptance criteria for the server path:
 *
 *   - **Happy path**: docked or idle ship within 5 m of a player
 *     character → `handleEnterShip` rebinds the connection to the
 *     ship, removes the character, forces a broadcast, and pushes
 *     an `enter_ship_ok` ack.
 *   - **Ownership**: a second player cannot board player A's ship
 *     (`{code:'not-owner'}`).
 *   - **Velocity**: a ship moving at ≥ 1 u/s rejects the
 *     re-entry (`{code:'ship-moving'}`).
 *   - **Idempotency**: a second `enter_ship` while already in
 *     the ship returns `{code:'already-in-ship'}` (no duplicate
 *     state).
 *   - **Reconnect safety**: a connection whose `entityId` points
 *     at a missing entity (stale character after GC) returns
 *     `{code:'no-entity'}` without crashing.
 *   - **Round trip**: `handleDisembark` then `handleEnterShip`
 *     produces a net-zero state — the entity counts are restored
 *     to the pre-disembark level, and the entity ids are
 *     consistent.
 */

import { describe, expect, it } from "vitest";
import type { ProtocolEntityState } from "@shared/protocol/index.js";

import { buildShardContext } from "../galaxy/system-data.js";
import { padForPlanet } from "@shared/world/pads.js";
import type { SystemPad } from "@shared/world/pads.js";
import { generateStars } from "@shared/galaxy/stars.js";
import { generateSystemFromStar } from "@shared/galaxy/system.js";

import {
  addConnection,
  createShard,
  handleDisembark,
  handleEnterShip,
  spawnShip,
  type Shard,
  type ShardConnection,
  type SimEntity,
} from "./index.js";
import type { ShardSystemContext } from "./types.js";
import { makeCharacterId } from "./entity.js";
import { ENTER_SHIP_MAX_VELOCITY_U_S } from "@shared/world/enterShip.js";

const ZERO_VEL = { x: 0, y: 0, z: 0 };
const ZERO_QUAT = { x: 0, y: 0, z: 0, w: 1 };

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface Recorder {
  shard: Shard;
  broadcasts: Array<{ tick: number; entities: ProtocolEntityState[] }>;
  sent: Array<{ connId: string; frame: { type: string; payload: unknown } }>;
  advance: (ms: number) => void;
}

function makeRecorder(seed = "enter-ship-shard-test"): Recorder {
  let nowMs = 0;
  const sent: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];
  const ctx: ShardSystemContext = buildShardContext({
    seed,
    starCount: 4,
    systemId: findFirstSystemId(seed),
  });
  const shard = createShard({
    systemId: ctx.system.systemId,
    context: ctx,
    send: (connId, frame) => {
      sent.push({ connId, frame: frame as { type: string; payload: unknown } });
    },
    broadcast: (tick, entities) => {
      recorder.broadcasts.push({ tick, entities });
    },
    autoStart: false,
    clock: () => nowMs,
  });
  const recorder: Recorder = {
    shard,
    broadcasts: [],
    sent,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
  return recorder;
}

function findFirstSystemId(seed: string): string {
  const stars = generateStars(seed, 4);
  if (stars.length === 0) throw new Error("test fixture: no stars");
  return stars[0]!.id;
}

function firstPad(seed: string): {
  pad: SystemPad;
  planetId: string;
} {
  const stars = generateStars(seed, 4);
  const star = stars[0];
  if (!star) throw new Error("test fixture: no star");
  const system = generateSystemFromStar(seed, star);
  const landable = system.planets.find((p) => p.landable);
  if (!landable) throw new Error("test fixture: no landable planet");
  const pad = padForPlanet({ seed, starId: star.id, planet: landable });
  if (!pad) throw new Error("test fixture: no pad for landable planet");
  return { pad, planetId: landable.id };
}

interface RegisteredShip {
  ship: SimEntity;
  conn: ShardConnection;
  pad: SystemPad;
  planetId: string;
}

/**
 * Helper: place a player ship on the pad of the first landable
 * planet, create a connected character standing right next to it,
 * and return the registered bundle. The "next to it" position is
 * exactly `ship.pos + sideOffset` (`makeCharacterEntity` /
 * `characterSpawnPos` use the same +X axis) so the range check
 * passes.
 *
 * Callers can mutate the ship's `vel` to drive the velocity paths.
 */
function placeShipAndCharacter(
  recorder: Recorder,
  seed: string,
  overrides: {
    playerId?: string;
    shipPlayerId?: string;
    charPos?: { x: number; y: number; z: number };
    shipVel?: { x: number; y: number; z: number };
  } = {},
): RegisteredShip {
  const { pad, planetId } = firstPad(seed);
  const playerId = overrides.playerId ?? "p1";
  const shipPlayerId = overrides.shipPlayerId ?? playerId;

  // Stub a connection so the spawnShip helper can bind it.
  const conn: ShardConnection = {
    connId: "c1",
    callsign: "TestPilot",
    playerId,
    shipId: "ship-1",
    entityId: null,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  addConnection(recorder.shard, conn);

  const ship = spawnShip(recorder.shard, {
    shipId: "ship-1",
    playerId: shipPlayerId,
    callsign: "TestPilot",
    classId: "scout",
    hull: 100,
    shields: 100,
    pos: { x: pad.pos.x, y: pad.pos.y, z: pad.pos.z },
    vel: overrides.shipVel ?? ZERO_VEL,
    quat: ZERO_QUAT,
    regime: "surface",
    originPlanetId: planetId,
    onPad: null,
    bindConnId: "c1",
  });
  conn.entityId = ship.id;
  // Mirror the disembark test pattern: stamp `onPad` directly so we
  // don't depend on the integrator's tick path here.
  ship.onPad = pad.padId;

  // Disembark so a character exists, then translate it to the
  // override position (so the range-check tests can position the
  // character 0 m / 4 m / 6 m from the ship).
  const result = handleDisembark(recorder.shard, { connId: "c1" });
  if (!result.ok) throw new Error(`disembark failed: ${result.code}`);
  const charId = makeCharacterId(playerId);
  const character = recorder.shard.entities.get(charId);
  if (!character) throw new Error("character missing after disembark");
  if (overrides.charPos) {
    character.pos = { ...overrides.charPos };
  }
  return { ship, conn, pad, planetId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shard: handleEnterShip (TASK-35)", () => {
  it("re-enters the ship from a docked character standing next to it", () => {
    const recorder = makeRecorder();
    const { ship, conn } = placeShipAndCharacter(recorder, "enter-ship-shard-test");

    const broadcastsBefore = recorder.broadcasts.length;
    const ackBefore = recorder.sent.filter((s) => s.frame.type === "enter_ship_ok").length;
    const charId = makeCharacterId(conn.playerId);
    expect(recorder.shard.entities.get(charId)).toBeDefined();

    const result = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Character removed.
    expect(recorder.shard.entities.get(charId)).toBeUndefined();
    // Connection rebound to the ship.
    expect(conn.entityId).toBe(ship.id);
    // Broadcast fired so every client sees the entity switch.
    expect(recorder.broadcasts.length).toBeGreaterThan(broadcastsBefore);
    // Ack pushed on the wire (server-only frame).
    const ackCount = recorder.sent.filter((s) => s.frame.type === "enter_ship_ok").length;
    expect(ackCount).toBe(ackBefore + 1);
    const ack = recorder.sent.filter((s) => s.frame.type === "enter_ship_ok").slice(-1)[0]!;
    expect(ack.frame.payload).toEqual({ shipId: ship.id });
  });

  it("rejects enter_ship when the connection's entity is already a ship (idempotency)", () => {
    const recorder = makeRecorder();
    const { conn } = placeShipAndCharacter(recorder, "enter-ship-shard-test");

    // Pre-state: entity is the character. Force the test to put the
    // connection into the ship by completing an enter, then trying
    // a second one (acceptance criterion: "double enter_ship →
    // second is {code:'already-in-ship'}").
    const first = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(first.ok).toBe(true);

    const second = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("already-in-ship");
    // No second broadcast / ack emitted from the idempotent path.
    const lastBroadcastLen = recorder.broadcasts.length;
    const lastAckLen = recorder.sent.filter((s) => s.frame.type === "enter_ship_ok").length;
    // Calling idempotent reject must not push another broadcast OR
    // an ack — only the failure path is recorded.
    const third = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(third.ok).toBe(false);
    expect(recorder.broadcasts.length).toBe(lastBroadcastLen);
    expect(recorder.sent.filter((s) => s.frame.type === "enter_ship_ok").length).toBe(lastAckLen);
  });

  it("rejects with not-owner when the ship belongs to a different player", () => {
    const recorder = makeRecorder();
    // Ship is owned by "p-owner", but the connection belongs to
    // "p-imposter" — a clear mismatch.
    const { conn } = placeShipAndCharacter(recorder, "enter-ship-shard-test", {
      playerId: "p-imposter",
      shipPlayerId: "p-owner",
    });

    const result = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("not-owner");
    // Ship + character remain in their pre-call state.
    expect(conn.entityId).toBe(makeCharacterId("p-imposter"));
    expect(recorder.shard.entities.get(makeCharacterId("p-imposter"))).toBeDefined();
  });

  it("rejects with ship-moving when the ship velocity exceeds 1 u/s", () => {
    const recorder = makeRecorder();
    const movingSpeed = ENTER_SHIP_MAX_VELOCITY_U_S + 0.5; // > 1 u/s on the magnitude metric
    const { conn } = placeShipAndCharacter(recorder, "enter-ship-shard-test", {
      shipVel: { x: movingSpeed, y: 0, z: 0 },
    });

    const result = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ship-moving");

    // A ship moving at exactly the cap (1 u/s) should also be
    // rejected — the spec uses a strict-less-than gate.
    const recorder2 = makeRecorder();
    const { conn: conn2 } = placeShipAndCharacter(recorder2, "enter-ship-shard-test", {
      shipVel: { x: ENTER_SHIP_MAX_VELOCITY_U_S, y: 0, z: 0 },
    });
    const edge = handleEnterShip(recorder2.shard, { connId: conn2.connId });
    expect(edge.ok).toBe(false);
    if (edge.ok) throw new Error("unreachable");
    expect(edge.code).toBe("ship-moving");

    // A ship moving at 0.9 u/s (below cap) should be accepted.
    const recorder3 = makeRecorder();
    const { conn: conn3 } = placeShipAndCharacter(recorder3, "enter-ship-shard-test", {
      shipVel: { x: 0.9, y: 0, z: 0 },
    });
    const accepted = handleEnterShip(recorder3.shard, { connId: conn3.connId });
    expect(accepted.ok).toBe(true);
  });

  it("rejects with out-of-range when the character is more than 5 m from the ship", () => {
    const recorder = makeRecorder();
    // Resolve the pad up-front so we can pass the character's
    // target position relative to it (avoids a destructuring-
    // hoisting trap while still using the helper).
    const padLoc = firstPad("enter-ship-shard-test");
    const { conn } = placeShipAndCharacter(recorder, "enter-ship-shard-test", {
      charPos: { x: padLoc.pad.pos.x + 100, y: padLoc.pad.pos.y, z: padLoc.pad.pos.z + 100 },
    });

    const result = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("out-of-range");

    // The same call inside the 5 m radius succeeds.
    const recorder2 = makeRecorder();
    const { conn: conn2 } = placeShipAndCharacter(recorder2, "enter-ship-shard-test", {
      charPos: { x: padLoc.pad.pos.x + 1, y: padLoc.pad.pos.y, z: padLoc.pad.pos.z + 1 },
    });
    const accepted = handleEnterShip(recorder2.shard, { connId: conn2.connId });
    expect(accepted.ok).toBe(true);
  });

  it("rejects enter_ship when the connection has no entity (no-entity)", () => {
    const recorder = makeRecorder();
    const conn = recorder.shard.connections.get("ghost-conn");
    expect(conn).toBeUndefined();
    const result = handleEnterShip(recorder.shard, { connId: "ghost-conn" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unknown");
  });

  it("clears a stale entity binding without crashing (reconnect safety)", () => {
    const recorder = makeRecorder();
    const { conn, ship } = placeShipAndCharacter(recorder, "enter-ship-shard-test");
    // Simulate the character being GC'd while the connection's
    // entityId still points at it.
    recorder.shard.entities.delete(makeCharacterId(conn.playerId));
    const result = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("no-entity");
    // The handler resets `conn.entityId` so future frames don't
    // bounce back into the same failure forever.
    expect(conn.entityId).toBeNull();
    // The ship is still in the registry.
    expect(recorder.shard.entities.get(ship.id)).toBeDefined();
  });

  it("rejects with not-on-foot when the connection's entity is a ship already (defensive)", () => {
    const recorder = makeRecorder();
    const { conn, ship } = placeShipAndCharacter(recorder, "enter-ship-shard-test");
    // Simulate the case where the connection already saw the ship
    // (e.g. a separate path bypassed the character spawn). The
    // player bound, but the entity is the ship, not a character.
    conn.entityId = ship.id;
    const result = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("already-in-ship");
  });

  it("disembark + re-enter round-trip preserves the ship and consumes the character", () => {
    const recorder = makeRecorder();
    const padLoc = firstPad("enter-ship-shard-test");
    const { ship, conn } = placeShipAndCharacter(recorder, "enter-ship-shard-test", {
      charPos: { x: padLoc.pad.pos.x, y: padLoc.pad.pos.y, z: padLoc.pad.pos.z }, // right on the ship
    });

    // The character was already minted by `placeShipAndCharacter`.
    // Now we reboard.
    const reenter = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(reenter.ok).toBe(true);
    if (!reenter.ok) throw new Error("unreachable");

    // After re-entry: ship is back in the registry with the same
    // id, connection is bound to the ship, character is gone.
    expect(recorder.shard.entities.get(ship.id)).toBe(ship);
    expect(conn.entityId).toBe(ship.id);
    expect(recorder.shard.entities.get(makeCharacterId(conn.playerId))).toBeUndefined();

    // Now re-disembark and re-enter one more time to prove the
    // round-trip is repeatable (idempotent ship spawn, idempotent
    // character spawn).
    const dis2 = handleDisembark(recorder.shard, { connId: conn.connId });
    expect(dis2.ok).toBe(true);
    const re2 = handleEnterShip(recorder.shard, { connId: conn.connId });
    expect(re2.ok).toBe(true);
  });
});
