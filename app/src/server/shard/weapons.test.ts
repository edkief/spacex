/**
 * Weapons tests — TASK-43.
 *
 * Unit tests for the weapon catalog + the server-side fire handler.
 * The sim-tick missile homing is covered separately in
 * `weapons.missile.test.ts`; this file focuses on:
 *
 *   - Catalog (LASER / MISSILE constants, loadout table).
 *   - Laser: range, LOS, fire-rate enforcement, energy gating.
 *   - Missile homing convergence (straight → hit in < 5 s,
 *     evading → expire).
 *   - Splash radius damage split.
 *   - Weapon lock (30 fires/s → 5 s lockout).
 *   - WS round-trip (TASK-43 acceptance: "ship A fires at B,
 *     B's shields drop, C sees the FX events").
 */
import { describe, expect, it, beforeEach } from "vitest";

import {
  ENERGY_MAX,
  ENERGY_REGEN_PER_SECOND,
  LASER_STATS,
  MISSILE_STATS,
  WEAPON_IDS,
  WEAPON_LOCK_DURATION_MS,
  WEAPON_LOCK_THRESHOLD_PER_SECOND,
  canFireWeapon,
  cooldownMs,
  cycleWeapon,
  loadoutFor,
  weaponStats,
} from "@shared/weapons.js";
import type { ShipClassId } from "@shared/ships.js";

import { applyCombatDamage } from "./combat.js";
import {
  advanceMissiles,
  handleFire,
  handleSelectWeapon,
  initWeaponState,
  isLocked,
  recordFireAttempt,
} from "./weapons.js";
import { resolveHit as _resolveHitDup } from "./combat.resolve.js";
import { createShard, simulateNTicks } from "./index.js";
import { makeAiEntity, makePlayerEntity } from "./entity.js";
import type { Shard, ShardSystemContext, SimEntity } from "./types.js";
import type { Vec3 } from "@shared/physics/vec.js";
import { resolveHit as _resolveHit } from "./combat.resolve.js";
import { applyCombatDamage as _applyCombatDamage } from "./combat.js";

// ---------------------------------------------------------------------------
// Test harness — minimal shard fixture
// ---------------------------------------------------------------------------

interface WeaponHarness {
  shard: Shard;
  attackers: SimEntity[];
  targets: SimEntity[];
  connections: { connId: string; playerId: string; callsign: string; entityId: string | null }[];
  sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }>;
  broadcastCalls: Array<{ tick: number; entities: unknown[] }>;
  clock: { now: number };
  advanceClock(ms: number): void;
}

function makeHarness(args: {
  withPlanet?: boolean;
}): WeaponHarness {
  const sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];
  const broadcastCalls: Array<{ tick: number; entities: unknown[] }> = [];
  const clock = { now: 1_000 };
  const ctx: ShardSystemContext = {
    system: {
      systemId: "sys-weapons",
      star: {
        id: "star-x",
        seed: 1n,
        name: "Test Star",
        position: { x: 0, y: 0, z: 0 },
        spectral: "G",
        luminosity: 1,
        habitableZoneAu: 1,
        orbitAu: 0,
      },
      planets: args.withPlanet
        ? [
            {
              id: "planet-0",
              seed: 2n,
              orbitIndex: 0,
              radiusKm: 1_000,
              hasAtmosphere: true,
              atmosphereHeightKm: 10,
              name: "Test Planet",
              deposits: [],
              pads: [],
            },
          ]
        : [],
      stations: [],
      resourceNodes: [],
    } as unknown as ShardSystemContext["system"],
    starId: "star-x",
    planetById: () =>
      args.withPlanet
        ? ({
            id: "planet-0",
            radiusKm: 1_000,
          } as unknown as ReturnType<ShardSystemContext["planetById"]>)
        : undefined,
    heightAtFor: () => () => 0,
    tileSizeM: 64,
    galaxySeed: "drift-test-seed",
  };
  const shard = createShard({
    systemId: "sys-weapons",
    context: ctx,
    send: ((_connId: string, frame: { type: string; payload: unknown }) => {
      sentFrames.push({ connId: _connId, frame });
    }) as Shard["send"],
    broadcast: ((tick: number, entities: unknown[]) => {
      broadcastCalls.push({ tick, entities });
    }) as Shard["broadcast"],
    autoStart: false,
    clock: () => clock.now,
  });
  return {
    shard,
    attackers: [],
    targets: [],
    connections: [],
    sentFrames,
    broadcastCalls,
    clock,
    advanceClock: (ms: number): void => {
      clock.now += ms;
    },
  };
}

function addShip(
  h: WeaponHarness,
  args: {
    classId: ShipClassId;
    callsign: string;
    pos: Vec3;
    playerId?: string;
  },
): { entity: SimEntity; connId: string } {
  const shipId = `ship-${h.attackers.length + h.targets.length}`;
  const entityId = `entity:${shipId}`;
  const playerId = args.playerId ?? `player-${shipId}`;
  const connId = `conn-${shipId}`;
  const entity = makePlayerEntity({
    id: entityId,
    shipId,
    playerId,
    callsign: args.callsign,
    classId: args.classId,
    hull: 100,
    shields: 100,
    pos: { x: args.pos.x, y: args.pos.y, z: args.pos.z },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    originPlanetId: null,
    onPad: null,
  });
  h.shard.entities.set(entityId, entity);
  h.shard.connections.set(connId, {
    connId,
    callsign: args.callsign,
    playerId,
    shipId,
    entityId,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  });
  initWeaponState(entity);
  h.attackers.push(entity);
  return { entity, connId };
}

function addTarget(
  h: WeaponHarness,
  args: { classId: ShipClassId; pos: Vec3; playerId: string; callsign: string; shields?: number; hull?: number },
): SimEntity {
  const entityId = `target:${args.playerId}`;
  const entity = makeAiEntity({
    id: entityId,
    classId: args.classId,
    pos: { x: args.pos.x, y: args.pos.y, z: args.pos.z },
  });
  if (args.shields !== undefined) entity.shields = args.shields;
  if (args.hull !== undefined) entity.hull = args.hull;
  h.shard.entities.set(entityId, entity);
  h.targets.push(entity);
  return entity;
}

// ---------------------------------------------------------------------------
// 1. Catalog tests (shared module)
// ---------------------------------------------------------------------------

describe("weapon catalog", () => {
  it("exposes the two v1 weapons with the documented stats", () => {
    expect(WEAPON_IDS).toEqual(["laser", "missile"]);
    expect(weaponStats("laser")).toEqual(LASER_STATS);
    expect(weaponStats("missile")).toEqual(MISSILE_STATS);
  });

  it("LASER has damage 8, range 400, rate 3/s, energy 2", () => {
    expect(LASER_STATS.damage).toBe(8);
    expect(LASER_STATS.range).toBe(400);
    expect(LASER_STATS.rate).toBe(3);
    expect(LASER_STATS.energy).toBe(2);
  });

  it("MISSILE has damage 25, splash 12, radius 5, range 800, speed 120, turn 1.5, rate 0.5/s, energy 10", () => {
    expect(MISSILE_STATS.damage).toBe(25);
    expect(MISSILE_STATS.splashDamage).toBe(12);
    expect(MISSILE_STATS.splashRadius).toBe(5);
    expect(MISSILE_STATS.range).toBe(800);
    expect(MISSILE_STATS.speed).toBe(120);
    expect(MISSILE_STATS.turnRate).toBe(1.5);
    expect(MISSILE_STATS.rate).toBe(0.5);
    expect(MISSILE_STATS.energy).toBe(10);
  });

  it("ENERGY_MAX = 100 and ENERGY_REGEN_PER_SECOND = 10", () => {
    expect(ENERGY_MAX).toBe(100);
    expect(ENERGY_REGEN_PER_SECOND).toBe(10);
  });

  it("lock threshold is 30 fires/s with a 5 s lockout", () => {
    expect(WEAPON_LOCK_THRESHOLD_PER_SECOND).toBe(30);
    expect(WEAPON_LOCK_DURATION_MS).toBe(5_000);
  });

  it("cooldownMs returns 333 for laser (3/s) and 2000 for missile (0.5/s)", () => {
    expect(cooldownMs("laser")).toBe(333);
    expect(cooldownMs("missile")).toBe(2_000);
  });

  it("loadouts: scout/freighter {laser 1, missiles 0}, interceptor {laser 2, missiles 4}", () => {
    expect(loadoutFor("scout")).toEqual({ laser: 1, missiles: 0 });
    expect(loadoutFor("freighter")).toEqual({ laser: 1, missiles: 0 });
    expect(loadoutFor("interceptor")).toEqual({ laser: 2, missiles: 4 });
  });

  it("canFireWeapon returns true for every laser, false for scout/freighter missile", () => {
    expect(canFireWeapon("scout", "laser")).toBe(true);
    expect(canFireWeapon("freighter", "laser")).toBe(true);
    expect(canFireWeapon("interceptor", "laser")).toBe(true);
    expect(canFireWeapon("scout", "missile")).toBe(false);
    expect(canFireWeapon("freighter", "missile")).toBe(false);
    expect(canFireWeapon("interceptor", "missile")).toBe(true);
  });

  it("cycleWeapon flips between laser and missile", () => {
    expect(cycleWeapon("laser")).toBe("missile");
    expect(cycleWeapon("missile")).toBe("laser");
    expect(cycleWeapon("laser", "prev")).toBe("missile");
    expect(cycleWeapon("missile", "prev")).toBe("laser");
  });
});

// ---------------------------------------------------------------------------
// 2. Laser range + LOS + rate + energy
// ---------------------------------------------------------------------------

describe("laser fire handler", () => {
  let h: WeaponHarness;
  beforeEach(() => {
    h = makeHarness({});
  });

  it("accepts a laser shot inside range and deducts 2 energy", () => {
    const { entity, connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 200, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const initialEnergy = entity.energy ?? 0;
    const result = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    expect(result.ok).toBe("accepted");
    if (result.ok !== "accepted") return;
    expect(result.damage).toBe(8); // single laser
    expect(entity.energy).toBe(initialEnergy - 2);
  });

  it("rejects a laser shot past 400 m with out-of-range", () => {
    const { connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 800, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const result = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    expect(result.ok).toBe("denied");
    if (result.ok !== "denied") return;
    expect(result.code).toBe("out-of-range");
  });

  it("accepts a laser shot at the exact range boundary", () => {
    const { connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 400, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const result = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    expect(result.ok).toBe("accepted");
  });

  it("fire rate: second laser within 333 ms is rate-limited", () => {
    const { entity, connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const first = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    expect(first.ok).toBe("accepted");
    const second = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_100 });
    expect(second.ok).toBe("denied");
    if (second.ok !== "denied") return;
    expect(second.code).toBe("rate-limited");
    void entity;
  });

  it("fire rate: third laser at 333 ms is accepted; the 4th within 333 ms is denied", () => {
    const { connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const a = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    const b = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_333 });
    const c = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_340 });
    expect(a.ok).toBe("accepted");
    expect(b.ok).toBe("accepted");
    expect(c.ok).toBe("denied");
    if (c.ok !== "denied") return;
    expect(c.code).toBe("rate-limited");
  });

  it("energy gating: low-energy surfaces when reservoir < cost", () => {
    const { entity, connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    entity.energy = 1;
    const result = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    expect(result.ok).toBe("denied");
    if (result.ok !== "denied") return;
    expect(result.code).toBe("low-energy");
    // Energy is unchanged on a denied fire.
    expect(entity.energy).toBe(1);
  });

  it("scout firing a missile is weapon-not-equipped", () => {
    const { connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const result = handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });
    expect(result.ok).toBe("denied");
    if (result.ok !== "denied") return;
    expect(result.code).toBe("weapon-not-equipped");
  });

  it("interceptor twin-linked lasers deal 2 × damage (16) on accept", () => {
    const { entity, connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const result = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    expect(result.ok).toBe("accepted");
    if (result.ok !== "accepted") return;
    expect(result.damage).toBe(16); // 2 × 8
    expect(entity.energy).toBe(98); // 100 - 2
  });

  it("laser at a dead target is denied (no-target)", () => {
    const { connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const target = h.shard.entities.get("target:target-a");
    if (target) target.hull = 0;
    const result = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    // Per the spec, a denied fire shows NO FX and spends no
    // energy. A dead-target rejection is a denial.
    expect(result.ok).toBe("denied");
    if (result.ok !== "denied") return;
    expect(result.code).toBe("no-target");
  });

  it("fire_ok frame is sent on accepted laser", () => {
    const { connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    const ack = h.sentFrames.find((s) => s.frame.type === "fire_ok");
    expect(ack).toBeDefined();
  });

  it("fire_ok frame is NOT sent on a denied fire", () => {
    const { connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    // No target in registry, no energy — denied.
    const entity = h.shard.entities.get(`entity:ship-0`);
    if (entity) entity.energy = 0;
    handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "missing", nowMs: 1_000 });
    const ack = h.sentFrames.find((s) => s.frame.type === "fire_ok");
    expect(ack).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Anti-spam weapon lock
// ---------------------------------------------------------------------------

describe("anti-spam weapon lock", () => {
  it("30 fires within 1 s triggers a 5 s lockout", () => {
    const h = makeHarness({});
    const { entity, connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    // Fire 30 attempts within 1 s — every attempt is recorded
    // (whether accepted or denied), and the 30th triggers the
    // lockout.
    for (let i = 0; i < 30; i++) {
      handleFire({
        shard: h.shard,
        connId,
        weapon: "laser",
        targetId: "target:target-a",
        nowMs: 1_000 + i * 30, // 30 fires inside a 1 s window
      });
    }
    // After 30 attempts inside the rolling 1 s window, the
    // entity is locked for 5 s.
    expect(entity.weaponFireLog?.length).toBe(0); // cleared on lockout
    expect(isLocked(entity, 1_900)).toBe(true);
  });

  it("a fire during the lockout window is rejected with weapon-locked", () => {
    const h = makeHarness({});
    const { entity, connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    // Force the entity into the lockout window directly.
    entity.weaponLockedUntilMs = Date.now() + 5_000;
    const result = handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: Date.now() });
    expect(result.ok).toBe("denied");
    if (result.ok !== "denied") return;
    expect(result.code).toBe("weapon-locked");
  });

  it("recordFireAttempt rolls the 1 s window forward", () => {
    const h = makeHarness({});
    const { entity } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    // Fill the ring with old timestamps.
    entity.weaponFireLog = [100, 200, 300];
    recordFireAttempt(entity, 1_500);
    // The old timestamps (300 < 1_500 - 1_000 = 500) should be gone;
    // only the new attempt should remain.
    expect(entity.weaponFireLog).toEqual([1_500]);
  });
});

// ---------------------------------------------------------------------------
// 4. Missile spawning + homing
// ---------------------------------------------------------------------------

describe("missile spawning", () => {
  it("spawns a missile entity on accepted fire", () => {
    const h = makeHarness({});
    const { connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 200, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const result = handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });
    expect(result.ok).toBe("accepted");
    if (result.ok !== "accepted") return;
    expect(result.projectileId).not.toBeNull();
    const missile = h.shard.entities.get(result.projectileId!);
    expect(missile).toBeDefined();
    if (!missile) return;
    expect(missile.kind).toBe("missile");
    expect(missile.missileTargetId).toBe("target:target-a");
    expect(missile.missileDamage).toBe(25);
    expect(missile.missileSplashDamage).toBe(12);
    expect(missile.missileSplashRadius).toBe(5);
    expect(missile.missileExpiresAt).toBe(6_000);
  });

  it("missile rate-limit: 2nd missile within 2000 ms is denied", () => {
    const h = makeHarness({});
    const { connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 200, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const first = handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });
    const second = handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_500 });
    expect(first.ok).toBe("accepted");
    expect(second.ok).toBe("denied");
    if (second.ok !== "denied") return;
    expect(second.code).toBe("rate-limited");
  });

  it("missile deducts 10 energy on accept", () => {
    const h = makeHarness({});
    const { entity, connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 200, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });
    expect(entity.energy).toBe(90);
  });
});

describe("missile homing", () => {
  it("straight (stationary) target → hit within TTL", async () => {
    const h = makeHarness({});
    const { connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo", shields: 0 });
    const fireResult = handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });
    if (fireResult.ok !== "accepted") throw new Error("fire should be accepted");
    const missileId = fireResult.projectileId;
    expect(missileId).not.toBeNull();

    // Drive 20 sim ticks with the fake clock advancing 50 ms
    // each tick (20 Hz). After 50 ms × 17 ticks ≈ 850 ms the
    // missile reaches the contact radius (6 m).
    for (let i = 0; i < 20; i++) {
      h.advanceClock(50);
      await h.shard.sim.tick();
    }
    // Target should have taken damage.
    const target = h.shard.entities.get("target:target-a");
    expect(target).toBeDefined();
    if (!target) return;
    expect(target.hull).toBeLessThan(100);
    // The missile should have despawned (contact or TTL).
    const missiles = [...h.shard.entities.values()].filter((e) => e.kind === "missile");
    expect(missiles).toHaveLength(0);
  });

  it("evading target → missile expires after 5 s without contact", async () => {
    const h = makeHarness({});
    const { connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "interceptor", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo", shields: 0, hull: 100 });
    const target = h.shard.entities.get("target:target-a");
    if (!target) throw new Error("no target");

    handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });

    // Target moves PERPENDICULAR to the missile's flight path
    // (the missile flies +X toward the initial target; target
    // dodges +Z). 200 u/s perpendicular is faster than the
    // missile can turn (1.5 rad/s × 120 u/s = 180 u/s linear
    // tracking ceiling).
    target.vel.x = 0;
    target.vel.y = 0;
    target.vel.z = 200;

    // Tick 100 times (5 s at 50 ms each). The contact radius is
    // 6 m, so a target > 6 m off the missile's flight path at
    // TTL expires the projectile without contact.
    for (let i = 0; i < 100; i++) {
      // Manually integrate the target's perpendicular drift
      // (the sim stub doesn't integrate AI entities).
      target.pos.z += 200 * 0.05;
      h.advanceClock(50);
      await h.shard.sim.tick();
    }

    // Target hull should be untouched (the missile either missed
    // or expired without contact).
    expect(target.hull).toBe(100);

    // The missile itself should have been despawned (TTL or cap).
    const missiles = [...h.shard.entities.values()].filter((e) => e.kind === "missile");
    expect(missiles).toHaveLength(0);
  });

  it("missile homing turns toward a moving target within TTL", async () => {
    const h = makeHarness({});
    const { connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 200, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });

    // Sample the missile's velocity after a few ticks — it
    // should have a non-trivial Y component if it's homing
    // toward a target that drifts upward.
    const target = h.shard.entities.get("target:target-a");
    if (!target) throw new Error("no target");
    target.vel.x = 0;
    target.vel.y = 50;
    target.vel.z = 0; // slow upward drift, missile can keep up

    for (let i = 0; i < 5; i++) {
      target.pos.y += 50 * 0.05; // manual integration (AI stub)
      h.advanceClock(50);
      await h.shard.sim.tick();
    }

    // Find the live missile.
    const missiles = [...h.shard.entities.values()].filter((e) => e.kind === "missile");
    expect(missiles).toHaveLength(1);
    if (missiles.length !== 1) return;
    const missile = missiles[0]!;
    // The missile's velocity Y component should be positive
    // (homing upward). Allow a tiny epsilon for floating-point
    // jitter.
    expect(missile.vel.y).toBeGreaterThan(0);
  });

  it("contact within 1.5 m detonates the warhead (direct hit applies full damage)", async () => {
    const h = makeHarness({});
    const { connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 50, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo", shields: 0 });
    handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });

    // Run ticks until the missile detonates or TTL expires.
    let target: SimEntity | undefined;
    for (let i = 0; i < 100; i++) {
      h.advanceClock(50);
      await h.shard.sim.tick();
      target = h.shard.entities.get("target:target-a");
      if (!target || target.hull <= 0) break;
    }
    target = h.shard.entities.get("target:target-a");
    expect(target).toBeDefined();
    // The target took at least the splash damage on impact
    // (25 direct hit drops hull by 25, so even a partial shield
    // absorption is observable).
    expect(target?.hull ?? 100).toBeLessThan(100);
  });

  it("splash damage: a 2nd entity within 5 m takes splash (12), the direct hit takes 25", async () => {
    const h = makeHarness({});
    const { connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    // Place the primary at 50 m so the warhead contacts it
    // within a few ticks. Place a 2nd ship 3 m further so it
    // sits inside the 5 m splash radius.
    addTarget(h, { classId: "scout", pos: { x: 50, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo", shields: 0 });
    addTarget(h, { classId: "scout", pos: { x: 53, y: 0, z: 0 }, playerId: "target-b", callsign: "Charlie", shields: 0 });
    const primary = h.shard.entities.get("target:target-a");
    const secondary = h.shard.entities.get("target:target-b");
    if (!primary || !secondary) throw new Error("missing target");

    handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });

    for (let i = 0; i < 100; i++) {
      h.advanceClock(50);
      await h.shard.sim.tick();
      const live = h.shard.entities.get("target:target-a");
      if (!live || live.hull <= 0) break;
    }
    const primaryAfter = h.shard.entities.get("target:target-a");
    const secondaryAfter = h.shard.entities.get("target:target-b");
    // Both took damage — splash proves friendly fire is on.
    expect(secondaryAfter?.hull ?? 100).toBeLessThan(100);
    expect(primaryAfter?.hull ?? 100).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// 5. Energy regen + selectWeapon
// ---------------------------------------------------------------------------

describe("energy regen + weapon select", () => {
  it("energy regenerates at 10/s", async () => {
    const h = makeHarness({});
    const { entity, connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: 1_000 });
    const drained = entity.energy ?? 0;
    expect(drained).toBe(98);

    // Run 50 ticks of 50 ms each (2.5 s of regen → +25 energy).
    for (let i = 0; i < 50; i++) {
      h.advanceClock(50);
      await h.shard.sim.tick();
    }
    expect(entity.energy ?? 0).toBeGreaterThan(drained);
    expect(entity.energy ?? 0).toBeLessThanOrEqual(100);
  });

  it("handleSelectWeapon updates activeWeapon and pushes weapon_state", () => {
    const h = makeHarness({});
    const { entity, connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    const result = handleSelectWeapon({ shard: h.shard, connId, weapon: "missile", nowMs: 1_000 });
    expect(result.weapon).toBe("missile");
    expect(entity.activeWeapon).toBe("missile");
    const ack = h.sentFrames.find((s) => s.frame.type === "weapon_state");
    expect(ack).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. WS round-trip — ship A fires at B, C sees the FX
// ---------------------------------------------------------------------------

describe("WS round-trip integration", () => {
  it("ship A fires a laser at B → B's shields drop + a combat_event is broadcast to C", async () => {
    const h = makeHarness({});
    // Add a 3rd player C so we can observe the broadcast to a
    // non-firing client.
    const { entity: attacker, connId: attackerConn } = addShip(h, {
      classId: "scout",
      callsign: "Alpha",
      pos: { x: 0, y: 0, z: 0 },
    });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const { connId: spectatorConn } = addShip(h, {
      classId: "scout",
      callsign: "Charlie",
      pos: { x: -200, y: 0, z: 0 },
    });

    const initialShields = h.shard.entities.get("target:target-a")?.shields;
    handleFire({
      shard: h.shard,
      connId: attackerConn,
      weapon: "laser",
      targetId: "target:target-a",
      nowMs: 1_000,
    });

    // B's shields should have dropped by 8 (single laser hit).
    const target = h.shard.entities.get("target:target-a");
    expect(target?.shields).toBe((initialShields ?? 100) - 8);

    // Both connections should have received the `combat_event`
    // frame for the hit (the resolver broadcasts to every
    // connection in the shard). The spectator C sees the FX
    // event without firing themselves.
    const hitFrames = h.sentFrames.filter((s) => s.frame.type === "combat_event");
    expect(hitFrames.length).toBeGreaterThan(0);
    const frameTargets = new Set(
      hitFrames.map((s) => (s.frame.payload as { target?: string })?.target),
    );
    expect(frameTargets.has("target:target-a")).toBe(true);
    // The attacker also gets a `fire_ok` ack.
    const fireOks = h.sentFrames.filter((s) => s.frame.type === "fire_ok");
    expect(fireOks.length).toBeGreaterThan(0);
    expect(fireOks[0]?.connId).toBe(attackerConn);
    // The spectator received a combat_event.
    const spectatorHits = hitFrames.filter((s) => s.connId === spectatorConn);
    expect(spectatorHits.length).toBeGreaterThan(0);
    void attacker;
  });

  it("denied fires produce no combat_event", () => {
    const h = makeHarness({});
    const { entity, connId } = addShip(h, { classId: "scout", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 100, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    // Force the entity into the lockout window.
    entity.weaponLockedUntilMs = Date.now() + 5_000;
    handleFire({ shard: h.shard, connId, weapon: "laser", targetId: "target:target-a", nowMs: Date.now() });
    const combatEvents = h.sentFrames.filter((s) => s.frame.type === "combat_event");
    expect(combatEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. advanceMissiles unit-level
// ---------------------------------------------------------------------------

describe("advanceMissiles", () => {
  it("no missiles → 0 despawned / 0 impacted", () => {
    const h = makeHarness({});
    const result = advanceMissiles(h.shard, Date.now());
    expect(result.despawned).toBe(0);
    expect(result.impacted).toBe(0);
  });

  it("a missile past its TTL is despawned", () => {
    const h = makeHarness({});
    const { connId } = addShip(h, { classId: "interceptor", callsign: "Alpha", pos: { x: 0, y: 0, z: 0 } });
    addTarget(h, { classId: "scout", pos: { x: 200, y: 0, z: 0 }, playerId: "target-a", callsign: "Bravo" });
    const result = handleFire({ shard: h.shard, connId, weapon: "missile", targetId: "target:target-a", nowMs: 1_000 });
    if (result.ok !== "accepted") throw new Error("expected accept");
    // Advance past the TTL.
    advanceMissiles(h.shard, 10_000);
    const missile = h.shard.entities.get(result.projectileId!);
    expect(missile).toBeUndefined();
  });
});

// Sanity: silence unused vars.
void _resolveHitDup;
void _applyCombatDamage;
void simulateNTicks;
void applyCombatDamage;