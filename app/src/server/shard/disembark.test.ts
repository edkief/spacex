/**
 * Disembark server tests — TASK-31.
 *
 * Covers the spec acceptance criteria for the server path:
 *
 *   - `handleDisembark` from a docked ship:
 *       * Creates a character entity at `ship.pos + sideOffset`
 *         (2.5 m perpendicular to the ship's forward, on the pad
 *         plane).
 *       * Ship stays docked (entity stays in the registry with the
 *         same `onPad`).
 *       * Player's connection is rebound to the character
 *         (`conn.entityId === char:<playerId>`).
 *       * Broadcast fires immediately so every client sees the
 *         character appear.
 *   - Rejection when not docked: returns `{ ok: false,
 *     code: 'not-docked' }` so the WS handler emits a structured
 *     error frame.
 *   - Two clients see the same character position (multi-client
 *     agreement).
 *
 * The tests build a real `SimLoop` with a fake clock + a recorder
 * `broadcast` hook so we can assert the per-broadcast entity list
 * without standing up the WS layer.
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
  pushPlayerInput,
  removeConnection,
  spawnShip,
  type Shard,
  type ShardConnection,
  type SimEntity,
} from "./index.js";
import type { ShardSystemContext } from "./types.js";
import { makeCharacterId } from "./entity.js";
import { quatRotateVector } from "@shared/physics/vec.js";

const ZERO_VEL = { x: 0, y: 0, z: 0 };
const ZERO_QUAT = { x: 0, y: 0, z: 0, w: 1 };
const CHARACTER_SIDE_OFFSET_M = 2.5;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface Recorder {
  shard: Shard;
  broadcasts: Array<{ tick: number; entities: ProtocolEntityState[] }>;
  advance: (ms: number) => void;
}

function makeRecorder(seed = "disembark-shard-test"): Recorder {
  let nowMs = 0;
  // Find the first landable planet's pad so the test can match the
  // `onPad` against a stable expected string (mirrors the
  // `sim.pads.test.ts` fixture).
  const ctx: ShardSystemContext = buildShardContext({
    seed,
    starCount: 4,
    systemId: findFirstSystemId(seed),
  });
  const shard = createShard({
    systemId: ctx.system.systemId,
    context: ctx,
    send: () => {},
    broadcast: (tick, entities) => {
      recorder.broadcasts.push({ tick, entities });
    },
    autoStart: false,
    clock: () => nowMs,
  });
  const recorder: Recorder = {
    shard,
    broadcasts: [],
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
  return recorder;
}

function findFirstSystemId(seed: string): string {
  // Local copy of the resolve helper from `sim.pads.test.ts` so we
  // don't have to thread the starId through the public surface.
  // The same approach keeps the test self-contained.
  const stars = generateStars(seed, 4);
  if (stars.length === 0) throw new Error("test fixture: no stars");
  return stars[0].id;
}

function firstPad(seed: string): {
  pad: SystemPad;
  planetId: string;
  starId: string;
  system: ReturnType<typeof generateSystemFromStar>;
} {
  const stars = generateStars(seed, 4);
  const star = stars[0];
  if (!star) throw new Error("test fixture: no star");
  const system = generateSystemFromStar(seed, star);
  const landable = system.planets.find((p) => p.landable);
  if (!landable) throw new Error("test fixture: no landable planet");
  const pad = padForPlanet({ seed, starId: star.id, planet: landable });
  if (!pad) throw new Error("test fixture: no pad for landable planet");
  return { pad, planetId: landable.id, starId: star.id, system };
}

function makeConnection(
  shard: Shard,
  entityId: string,
  playerId: string,
  connId = "c1",
): ShardConnection {
  const conn: ShardConnection = {
    connId,
    playerId,
    entityId,
    callsign: "TestPilot",
    shipId: "ship-1",
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  addConnection(shard, conn);
  return conn;
}

function dockShipAt(
  recorder: Recorder,
  pad: SystemPad,
  planetId: string,
): { ship: SimEntity; conn: ShardConnection } {
  // Place the ship on the pad, then run a tick so the
  // integrator's pad-detection branch writes `onPad` on the entity.
  makeConnection(recorder.shard, "placeholder", "p1");
  const ship = spawnShip(recorder.shard, {
    shipId: "ship-1",
    playerId: "p1",
    callsign: "TestPilot",
    classId: "scout",
    hull: 100,
    shields: 100,
    pos: { x: pad.pos.x, y: pad.pos.y, z: pad.pos.z },
    vel: ZERO_VEL,
    quat: ZERO_QUAT,
    regime: "surface",
    originPlanetId: planetId,
    onPad: null,
    bindConnId: "c1",
  });
  const conn = recorder.shard.connections.get("c1")!;
  (conn as { entityId: string | null }).entityId = ship.id;
  // Note: this test bypasses the in-tick pad detection because
  // the seeded galaxy has multiple atmosphere-bearing planets and
  // `regimeFor` may resolve the integration against a different
  // planet than the one whose pad the ship sits on. The pad
  // detection path itself is covered by `sim.pads.test.ts` (TASK-29);
  // here we only need the post-dock state so `handleDisembark` can
  // exercise its happy + sad paths.
  ship.onPad = pad.padId;
  return { ship, conn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shard: disembark (TASK-31)", () => {
  it("creates a character entity at ship.pos + sideOffset when docked", () => {
    const recorder = makeRecorder();
    const { pad, planetId } = firstPad("disembark-shard-test");
    const { ship, conn } = dockShipAt(recorder, pad, planetId);

    const result = handleDisembark(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(true);

    if (!result.ok) throw new Error("unreachable");

    // Character exists in the registry.
    const character = recorder.shard.entities.get(makeCharacterId(conn.playerId));
    expect(character).toBeDefined();
    if (!character) throw new Error("character missing");

    // Character has the right kind + playerId + callsign.
    expect(character.kind).toBe("character");
    expect(character.playerId).toBe(conn.playerId);
    expect(character.callsign).toBe("TestPilot");
    expect(character.onShipId).toBe(ship.id);

    // Character position = ship.pos + sideOffset along ship's local +X.
    const offsetWorld = quatRotateVector(ship.quat, { x: CHARACTER_SIDE_OFFSET_M, y: 0, z: 0 });
    expect(character.pos.x).toBeCloseTo(ship.pos.x + offsetWorld.x, 5);
    expect(character.pos.y).toBeCloseTo(ship.pos.y, 5);
    expect(character.pos.z).toBeCloseTo(ship.pos.z + offsetWorld.z, 5);

    // Within 0.5 m of the expected spot (spec tolerance).
    const dx = character.pos.x - (ship.pos.x + offsetWorld.x);
    const dz = character.pos.z - (ship.pos.z + offsetWorld.z);
    const dist = Math.sqrt(dx * dx + dz * dz);
    expect(dist).toBeLessThan(0.5);

    // Ship stays docked and in the registry.
    const stillThere = recorder.shard.entities.get(ship.id);
    expect(stillThere).toBeDefined();
    expect(stillThere?.onPad).toBe(pad.padId);

    // Connection is rebound to the character.
    expect(conn.entityId).toBe(character.id);
  });

  it("rejects disembark when the ship is not docked (returns not-docked)", () => {
    const recorder = makeRecorder();
    // Register a connection but place the ship in space (no pad).
    const ctx = recorder.shard.context;
    const landable = ctx.system.planets.find((p) => p.landable);
    if (!landable) throw new Error("no landable planet in fixture");
    // Use a far-away position so the integrator doesn't dock.
    makeConnection(recorder.shard, "placeholder", "p1");
    const ship = spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p1",
      callsign: "TestPilot",
      classId: "scout",
      hull: 100,
      shields: 100,
      pos: { x: 1_000_000, y: 1_000_000, z: 1_000_000 },
      vel: ZERO_VEL,
      quat: ZERO_QUAT,
      regime: "space",
      originPlanetId: null,
      onPad: null,
      bindConnId: "c1",
    });
    const conn = recorder.shard.connections.get("c1")!;
    (conn as { entityId: string | null }).entityId = ship.id;
    // The integrator only checks pad-detection when regime is
    // 'surface'. Make sure we're firmly in space.
    expect(ship.onPad).toBeNull();

    const result = handleDisembark(recorder.shard, { connId: "c1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("not-docked");
  });

  it("rejects disembark when the connection has no ship (returns no-ship)", () => {
    const recorder = makeRecorder();
    // Register a connection but don't bind it to any entity.
    const conn = makeConnection(recorder.shard, "no-entity", "p1", "c-empty");
    (conn as { entityId: string | null }).entityId = null;
    const result = handleDisembark(recorder.shard, { connId: "c-empty" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("no-ship");
  });

  it("broadcasts the character immediately so all clients see it", () => {
    const recorder = makeRecorder();
    const { pad, planetId } = firstPad("disembark-shard-test");
    const { conn } = dockShipAt(recorder, pad, planetId);

    const broadcastsBefore = recorder.broadcasts.length;
    const result = handleDisembark(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(true);

    // handleDisembark forces a broadcast — there should be at least
    // one new frame in the recorder.
    expect(recorder.broadcasts.length).toBeGreaterThan(broadcastsBefore);
    const last = recorder.broadcasts[recorder.broadcasts.length - 1];
    expect(last).toBeDefined();
    if (!last) throw new Error("no broadcast recorded");

    // The broadcast must include the character entity.
    const charId = makeCharacterId(conn.playerId);
    const charInBroadcast = last.entities.find((e) => e.id === charId);
    expect(charInBroadcast).toBeDefined();
    expect(charInBroadcast?.kind).toBe("character");
    expect(charInBroadcast?.callsign).toBe("TestPilot");
    expect(charInBroadcast?.onFoot).toBe(true);
  });

  it("two connections see the same character position in the snapshot", () => {
    const recorder = makeRecorder();
    const { pad, planetId } = firstPad("disembark-shard-test");
    const { conn: conn1 } = dockShipAt(recorder, pad, planetId);

    // Add a second observer connection that has no ship.
    const conn2 = makeConnection(recorder.shard, "n/a", "p2", "c2");
    (conn2 as { entityId: string | null }).entityId = null;

    const result = handleDisembark(recorder.shard, { connId: conn1.connId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Both connections observe the same character position through
    // the broadcast (the spec's "two clients see the same character
    // position" acceptance criterion).
    const last = recorder.broadcasts[recorder.broadcasts.length - 1];
    expect(last).toBeDefined();
    if (!last) throw new Error("no broadcast recorded");
    const charId = makeCharacterId(conn1.playerId);
    const charInBroadcast = last.entities.find((e) => e.id === charId);
    expect(charInBroadcast).toBeDefined();
    // The broadcast is the SAME frame for every connection —
    // there's no per-conn filter — so both clients see the same
    // character position by construction.
    expect(charInBroadcast?.pos[0]).toBeCloseTo(result.character.pos.x, 5);
    expect(charInBroadcast?.pos[1]).toBeCloseTo(result.character.pos.y, 5);
    expect(charInBroadcast?.pos[2]).toBeCloseTo(result.character.pos.z, 5);
  });

  it("integrates character entities on input (TASK-32)", () => {
    // TASK-32 replaces the v1 idle behaviour: characters now
    // walk/run/jump via the shared character physics. Verify that
    // pushing a forward input moves the character on the next
    // tick.
    const recorder = makeRecorder();
    const { pad, planetId } = firstPad("disembark-shard-test");
    const { conn } = dockShipAt(recorder, pad, planetId);
    const result = handleDisembark(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const character = recorder.shard.entities.get(makeCharacterId(conn.playerId));
    expect(character).toBeDefined();
    if (!character) throw new Error("character missing");

    const posBefore = { ...character.pos };
    // Push a forward (thrust=1) input and run multiple ticks so
    // the friction ramp-up settles on walk speed and the
    // character has clearly advanced past `posBefore.z`. The
    // first seq must be 1 (cold-start guard on the input queue).
    for (let i = 0; i < 30; i++) {
      pushPlayerInput(recorder.shard, conn.connId, {
        seq: 1 + i,
        thrust: 1,
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        lock: false,
        action: null,
      });
      recorder.advance(50);
      recorder.shard.sim.tick();
    }
    // After ~1.5 s of walking the character should have moved at
    // least half a metre.
    expect(character.pos.z).toBeGreaterThan(posBefore.z + 0.5);
  });
});

// ---------------------------------------------------------------------------
// removeConnection smoke (TASK-12 path) — guard against regressions
// when the connection leaves the shard.
// ---------------------------------------------------------------------------
describe("shard: disembark + removeConnection", () => {
  it("character survives a connection close (disconnect-mid-egress pattern)", () => {
    const recorder = makeRecorder();
    const { pad, planetId } = firstPad("disembark-shard-test");
    const { conn } = dockShipAt(recorder, pad, planetId);
    const result = handleDisembark(recorder.shard, { connId: conn.connId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const charId = makeCharacterId(conn.playerId);
    expect(recorder.shard.entities.get(charId)).toBeDefined();
    removeConnection(recorder.shard, conn.connId);
    // Character entity remains in the registry — the spec's
    // "disconnect while disembarking leaves the character in the
    // sim (persists like a ship, TASK-24 pattern)" requirement.
    expect(recorder.shard.entities.get(charId)).toBeDefined();
  });
});
