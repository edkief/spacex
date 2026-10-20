/**
 * Destruction + respawn integration tests — TASK-49 acceptance.
 *
 * Covers the full death-and-recovery loop:
 *   - cargo loss (credits / inventory untouched — the PRD's risk
 *     model stakes the hold, not the player),
 *   - wreck entity + killer attribution surviving the swap,
 *   - respawn at the nearest dock in a full-HP starter scout,
 *   - docked-ship invulnerability (docks are safe zones),
 *   - wreck TTL expiry,
 *   - two players observing the same wreck.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCombatDamage, cleanupExpiredWrecks, WRECK_TTL_MS } from "./combat.js";
import { resolveHit } from "./combat.resolve.js";
import {
  handleShipDestruction,
  isDestructible,
  nearestDockPad,
  RESPAWN_SHIP_CLASS,
} from "./destruction.js";
import { makeWreckId } from "./entity.js";
import {
  addConnection,
  buildSnapshotEntities,
  createShard,
  removeConnection,
  spawnShip,
  type Shard,
  type ShardConnection,
} from "./index.js";
import type { ShardSystemContext } from "./types.js";
import type { ProtocolCombatEvent } from "@shared/protocol/index.js";
import { shipStats } from "@shared/ships.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAD_A = { padId: "pad-a", planetId: "planet-a", x: 100, y: 1000, z: 0 };
const PAD_B = { padId: "pad-b", planetId: "planet-b", x: 0, y: 1000, z: 4000 };

function makeContext(): ShardSystemContext {
  return {
    starId: "star-test",
    system: {
      systemId: "test-system",
      name: "Test",
      star: { id: "star-test", name: "Test Star", class: "G", x: 0, y: 0, z: 0, systemCount: 1 },
      planets: [
        {
          id: "planet-a",
          name: "A",
          landable: true,
          radiusKm: 1,
          hasAtmosphere: true,
          orbitIndex: 0,
        },
        {
          id: "planet-b",
          name: "B",
          landable: true,
          radiusKm: 1,
          hasAtmosphere: true,
          orbitIndex: 1,
        },
      ] as never,
    },
    planetById: () => undefined,
    heightAtFor: () => undefined,
    tileSizeM: 64,
    padsForSystem: () =>
      [PAD_A, PAD_B].map((p) => ({
        padId: p.padId,
        planetId: p.planetId,
        kind: "station" as const,
        pos: { x: p.x, y: p.y, z: p.z },
        normal: { x: 0, y: 1, z: 0 },
        radius: 20,
        exitRadius: 25,
      })),
  };
}

function makeConnection(args: {
  connId: string;
  playerId: string;
  shipId: string;
}): ShardConnection {
  return {
    connId: args.connId,
    callsign: `pilot-${args.playerId}`,
    playerId: args.playerId,
    shipId: args.shipId,
    entityId: null,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
}

interface Recorder {
  shard: Shard;
  frames: Array<{ connId: string; frame: { type?: string; payload?: unknown } }>;
}

function makeShard(): Recorder {
  const frames: Recorder["frames"] = [];
  const shard = createShard({
    systemId: "test-system",
    context: makeContext(),
    send: (connId, frame) => {
      frames.push({ connId, frame: frame as { type?: string; payload?: unknown } });
    },
    broadcast: () => undefined,
    onTickObserver: null,
    autoStart: false,
  });
  return { shard, frames };
}

function combatEvents(rec: Recorder): ProtocolCombatEvent[] {
  return rec.frames
    .filter((f) => f.frame.type === "combat_event")
    .map((f) => f.frame.payload as ProtocolCombatEvent);
}

/** Spawn a player ship + connection pair in space (never docked). */
function seedPlayer(
  rec: Recorder,
  args: {
    connId: string;
    playerId: string;
    shipId: string;
    pos: { x: number; y: number; z: number };
  },
): ShardConnection {
  const conn = makeConnection(args);
  addConnection(rec.shard, conn);
  spawnShip(rec.shard, {
    shipId: args.shipId,
    playerId: args.playerId,
    callsign: conn.callsign,
    classId: "scout",
    hull: shipStats("scout").hull,
    shields: shipStats("scout").shieldCapacity,
    pos: args.pos,
    regime: "space",
    originPlanetId: null,
    onPad: null,
    bindConnId: args.connId,
  });
  return conn;
}

// ---------------------------------------------------------------------------
// Destruction transaction
// ---------------------------------------------------------------------------

describe("handleShipDestruction — cargo loss + respawn", () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = makeShard();
  });
  afterEach(() => {
    rec.shard.shutdown();
  });

  it("deletes the cargo stacks and keeps the hold valid", () => {
    const conn = seedPlayer(rec, {
      connId: "c1",
      playerId: "p1",
      shipId: "s1",
      pos: { x: 0, y: 0, z: 0 },
    });
    const ship = rec.shard.entities.get(conn.entityId!)!;
    ship.cargo = { stacks: { iron: 12, crystal: 3 }, weightUsed: 21, capacity: 40 };

    const lost = handleShipDestruction({
      shard: rec.shard,
      destroyed: ship,
      wreckId: makeWreckId(ship.id),
      tick: 1,
    });

    expect(lost.handled).toBe(true);
    expect(lost.cargoLost).toEqual({ iron: 12, crystal: 3 });
    const respawned = rec.shard.entities.get(lost.respawnEntityId!)!;
    expect(respawned.cargo!.stacks).toEqual({});
    expect(respawned.cargo!.weightUsed).toBe(0);
  });

  it("respawns in a fresh full-HP starter scout docked on the nearest pad", () => {
    // Kill position sits 4 km from PAD_B and 100 m from PAD_A.
    const conn = seedPlayer(rec, {
      connId: "c1",
      playerId: "p1",
      shipId: "s1",
      pos: { x: 400, y: 1000, z: 3800 },
    });
    const ship = rec.shard.entities.get(conn.entityId!)!;

    const outcome = handleShipDestruction({
      shard: rec.shard,
      destroyed: ship,
      wreckId: makeWreckId(ship.id),
      tick: 7,
    });

    expect(outcome.respawn).not.toBeNull();
    expect(outcome.respawn!.padId).toBe("pad-b");
    expect(outcome.respawn!.planetId).toBe("planet-b");
    const scout = rec.shard.entities.get(outcome.respawnEntityId!)!;
    expect(scout.classId).toBe(RESPAWN_SHIP_CLASS);
    expect(scout.hull).toBe(shipStats(RESPAWN_SHIP_CLASS).hull);
    expect(scout.shields).toBe(shipStats(RESPAWN_SHIP_CLASS).shieldCapacity);
    expect(scout.onPad).toBe("pad-b");
    expect(scout.pos).toEqual({ x: PAD_B.x, y: PAD_B.y, z: PAD_B.z });
    // The connection now drives the replacement ship.
    expect(conn.entityId).toBe(scout.id);
    expect(scout.cargo!.stacks).toEqual({});
  });

  it("carries the killer attribution onto the respawn summary", () => {
    const killer = seedPlayer(rec, {
      connId: "c1",
      playerId: "p1",
      shipId: "s1",
      pos: { x: 0, y: 0, z: 0 },
    });
    const victim = seedPlayer(rec, {
      connId: "c2",
      playerId: "p2",
      shipId: "s2",
      pos: { x: 50, y: 0, z: 0 },
    });
    const victimShip = rec.shard.entities.get(victim.entityId!)!;
    const wreckId = makeWreckId(victimShip.id);
    rec.shard.entities.set(wreckId, {
      ...victimShip,
      id: wreckId,
      kind: "wreck",
      hull: 0,
      playerId: null,
      killerEntityId: killer.entityId!,
      killerKind: "player",
      killerWeapon: "laser",
      wreckExpiresAt: Date.now() + WRECK_TTL_MS,
    });

    const outcome = handleShipDestruction({
      shard: rec.shard,
      destroyed: victimShip,
      wreckId,
      tick: 3,
    });

    expect(outcome.respawn!.killer).toBe(killer.callsign);
    expect(outcome.respawn!.wreckId).toBe(wreckId);
  });

  it("is a no-op for a ship nobody owns (AI death path)", () => {
    const ship = spawnShip(rec.shard, {
      shipId: "s9",
      playerId: "ghost",
      callsign: "ghost",
      classId: "scout",
      hull: 10,
      shields: 10,
      pos: { x: 1, y: 1, z: 1 },
    });
    const outcome = handleShipDestruction({
      shard: rec.shard,
      destroyed: ship,
      wreckId: makeWreckId(ship.id),
      tick: 1,
    });
    expect(outcome.handled).toBe(false);
    expect(outcome.respawnEntityId).toBeNull();
    // The orphan's record is untouched — TASK-45 owns orphan respawn.
    expect(rec.shard.entities.has(ship.id)).toBe(true);
  });

  it("nearestDockPad picks by 3D distance with no radius cap", () => {
    expect(nearestDockPad(rec.shard, { x: 101, y: 1001, z: 1 })!.padId).toBe("pad-a");
    expect(nearestDockPad(rec.shard, { x: 0, y: 1000, z: 4001 })!.padId).toBe("pad-b");
    expect(nearestDockPad(rec.shard, { x: 40_000, y: 0, z: 0 })!.padId).toBe("pad-a");
  });

  it("isDestructible is false for docked ships (safe zone guard)", () => {
    const conn = seedPlayer(rec, {
      connId: "c1",
      playerId: "p1",
      shipId: "s1",
      pos: { x: 0, y: 0, z: 0 },
    });
    const ship = rec.shard.entities.get(conn.entityId!)!;
    expect(isDestructible(ship)).toBe(true);
    ship.onPad = "pad-a";
    expect(isDestructible(ship)).toBe(false);
    ship.onPad = null;
    ship.hull = 0;
    expect(isDestructible(ship)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: A kills B through the real damage pipeline
// ---------------------------------------------------------------------------

describe("applyCombatDamage — destruction → respawn", () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = makeShard();
  });
  afterEach(() => {
    rec.shard.shutdown();
  });

  it("A kills B: B respawns docked, cargo gone, wreck kept with A's attribution", () => {
    seedPlayer(rec, { connId: "c1", playerId: "p1", shipId: "s1", pos: { x: 0, y: 0, z: 0 } });
    const victim = seedPlayer(rec, {
      connId: "c2",
      playerId: "p2",
      shipId: "s2",
      pos: { x: 4200, y: 1000, z: 3900 },
    });
    const attacker = rec.shard.connections.get("c1")!;
    const attackerShip = rec.shard.entities.get(attacker.entityId!)!;
    const victimShip = rec.shard.entities.get(victim.entityId!)!;
    victimShip.cargo = { stacks: { iron: 40 }, weightUsed: 40, capacity: 40 };

    applyCombatDamage({
      shard: rec.shard,
      targetId: victimShip.id,
      amount: 10_000,
      source: { kind: "player", id: attacker.callsign },
      tick: 42,
      nowMs: 2_000_000,
      sourceEntityId: attackerShip.id,
      weapon: "laser",
    });

    // Wreck present with the killer's entity id + the spec's TTL.
    const wreckId = makeWreckId(victimShip.id);
    const wreck = rec.shard.entities.get(wreckId)!;
    expect(wreck.kind).toBe("wreck");
    expect(wreck.killerEntityId).toBe(attackerShip.id);
    expect(wreck.wreckExpiresAt).toBe(2_000_000 + WRECK_TTL_MS);

    // B's connection now drives a fresh scout at the nearest dock.
    const scout = rec.shard.entities.get(victim.entityId!)!;
    expect(scout.id).toBe(victimShip.id);
    expect(scout.classId).toBe(RESPAWN_SHIP_CLASS);
    expect(scout.hull).toBe(shipStats(RESPAWN_SHIP_CLASS).hull);
    expect(scout.onPad).not.toBeNull();
    expect(scout.cargo!.stacks).toEqual({});

    // The `destroyed` frame carries the respawn summary (the client
    // renders the 2 s "SHIP LOST" moment from it).
    const destroyed = combatEvents(rec).find((e) => e.kind === "destroyed");
    expect(destroyed).toBeDefined();
    expect(destroyed!.kind === "destroyed" && destroyed!.respawn).toBeDefined();
    const summary = destroyed!.kind === "destroyed" ? destroyed!.respawn! : undefined;
    expect(summary!.callsign).toBe(victim.callsign);
    expect(summary!.killer).toBe(attacker.callsign);
    expect(summary!.cargoLost).toEqual({ iron: 40 });

    // Both players observe the same wreck in the snapshot.
    const snapshot = buildSnapshotEntities(rec.shard);
    expect(snapshot.filter((e) => e.kind === "wreck")).toHaveLength(1);
  });

  it("expires wrecks after the 600 s TTL", () => {
    seedPlayer(rec, { connId: "c1", playerId: "p1", shipId: "s1", pos: { x: 0, y: 0, z: 0 } });
    const ship = rec.shard.entities.get(rec.shard.connections.get("c1")!.entityId!)!;
    applyCombatDamage({
      shard: rec.shard,
      targetId: ship.id,
      amount: 10_000,
      source: { kind: "player", id: "pilot-x" },
      tick: 1,
      nowMs: 1_000_000,
      sourceEntityId: ship.id === "" ? "" : "killer",
      weapon: "laser",
    });
    expect(rec.shard.entities.has(makeWreckId(ship.id))).toBe(true);
    cleanupExpiredWrecks(rec.shard, 1_000_000 + WRECK_TTL_MS + 1);
    expect(rec.shard.entities.has(makeWreckId(ship.id))).toBe(false);
    // The respawned scout survives the wreck reap.
    expect(rec.shard.entities.get(ship.id)).toBeDefined();
  });

  it("keeps the wreck when the killed player's connection has gone", () => {
    const victim = seedPlayer(rec, {
      connId: "c2",
      playerId: "p2",
      shipId: "s2",
      pos: { x: 4200, y: 1000, z: 3900 },
    });
    const victimShip = rec.shard.entities.get(victim.entityId!)!;
    removeConnection(rec.shard, "c2");
    // A bystander stays connected so we can observe the broadcast.
    seedPlayer(rec, { connId: "c3", playerId: "p3", shipId: "s3", pos: { x: 100, y: 0, z: 0 } });
    applyCombatDamage({
      shard: rec.shard,
      targetId: victimShip.id,
      amount: 10_000,
      source: { kind: "ai", id: "rogue" },
      tick: 5,
      nowMs: 1_500_000,
      sourceEntityId: "ai:rogue",
      weapon: "missile",
    });
    expect(rec.shard.entities.has(makeWreckId(victimShip.id))).toBe(true);
    // No owner → no respawn frame payload.
    const destroyed = combatEvents(rec).find((e) => e.kind === "destroyed");
    expect(destroyed!.kind === "destroyed" && destroyed!.respawn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Docked invulnerability
// ---------------------------------------------------------------------------

describe("resolveHit — docked ships are invulnerable", () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = makeShard();
  });
  afterEach(() => {
    rec.shard.shutdown();
  });

  it("rejects a shot at a docked ship and leaves hull untouched", () => {
    seedPlayer(rec, { connId: "c1", playerId: "p1", shipId: "s1", pos: { x: 0, y: 0, z: 0 } });
    const victim = seedPlayer(rec, {
      connId: "c2",
      playerId: "p2",
      shipId: "s2",
      pos: { x: 100, y: 1000, z: 0 },
    });
    const attackerShip = rec.shard.entities.get(rec.shard.connections.get("c1")!.entityId!)!;
    const victimShip = rec.shard.entities.get(victim.entityId!)!;
    victimShip.onPad = PAD_A.padId;
    const hullBefore = victimShip.hull;

    const resolved = resolveHit({
      shard: rec.shard,
      weapon: "laser",
      sourceId: attackerShip.id,
      targetId: victimShip.id,
      damage: 40,
      damagePoint: { ...victimShip.pos },
      range: 500,
      tick: 3,
    });

    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.rejection).toBe("docked-target");
    expect(victimShip.hull).toBe(hullBefore);
  });

  it("still damages the same ship once it undocks", () => {
    seedPlayer(rec, { connId: "c1", playerId: "p1", shipId: "s1", pos: { x: 0, y: 0, z: 0 } });
    const victim = seedPlayer(rec, {
      connId: "c2",
      playerId: "p2",
      shipId: "s2",
      pos: { x: 100, y: 1000, z: 0 },
    });
    const attackerShip = rec.shard.entities.get(rec.shard.connections.get("c1")!.entityId!)!;
    const victimShip = rec.shard.entities.get(victim.entityId!)!;
    const hullBefore = victimShip.hull;

    const resolved = resolveHit({
      shard: rec.shard,
      weapon: "laser",
      sourceId: attackerShip.id,
      targetId: victimShip.id,
      damage: 40,
      damagePoint: { ...victimShip.pos },
      range: 2000,
      tick: 3,
    });

    expect(resolved.ok).toBe(true);
    expect(victimShip.hull + victimShip.shields).toBeLessThan(
      hullBefore + shipStats("scout").shieldCapacity,
    );
  });
});
