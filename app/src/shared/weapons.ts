/**
 * Weapon contract (TASK-42 fixed the shape; TASK-43 supplies the concrete
 * v1 weapons): instant-hit lasers and arcing guided missiles, with
 * per-class loadouts from the ship catalog, fire-rate limits and the
 * per-ship energy model.
 *
 * Units: `damage` is ABSOLUTE points (the same space the shared damage
 * model in @shared/physics/damage works in — scout 100/50, freighter 200/80,
 * interceptor 80/40); `range` is METRES (a hit claimed beyond it is
 * rejected server-side: the client never decides whether a shot lands).
 *
 * All flight math here is PURE (no imports beyond @shared/physics/vec), so
 * the server sim and any future client predictor run bit-identical code.
 */

import {
  vecAdd,
  vecCross,
  vecDot,
  vecLength,
  vecNormalize,
  vecScale,
  vecSub,
  type Vec3,
} from '@shared/physics/vec';
import { SHIP_CLASSES, type ShipClassId } from './ships';

export type WeaponKind = 'laser' | 'missile';
export type WeaponId = WeaponKind;

export interface WeaponSpec {
  /** Stable wire id ('laser' / 'missile' in v1) — rides every combat event. */
  id: WeaponId;
  /** Weapon behavior (set on the v1 armory; test synthetics may omit it). */
  kind?: WeaponKind;
  /** Damage in ABSOLUTE points (shield-first through the shared model). */
  damage: number;
  /** Max engagement range in METRES (firing entity → damage point). */
  range: number;
  /** Shots per second (the server's per-weapon cooldown is 1/rate seconds). */
  fireRate?: number;
  /** Energy units spent on an ACCEPTED fire (denied fires spend nothing). */
  energy?: number;
  /** Missile only: damage to OTHERS inside the splash radius. */
  splashDamage?: number;
  /** Missile only: splash radius in METRES (also the impact contact radius). */
  splashRadius?: number;
  /** Missile only: flight speed (u/s). */
  speed?: number;
  /** Missile only: max turn rate (rad/s) toward the target each tick. */
  turnRate?: number;
  /** Missile only: lifetime in SECONDS — expires (no hit) when it elapses. */
  ttl?: number;
}

/** The instant-hit laser: a ray from the nose, first valid target or terrain. */
export const LASER: WeaponSpec = {
  id: 'laser',
  kind: 'laser',
  damage: 8,
  range: 400,
  fireRate: 3,
  energy: 2,
};

/** The homing missile: a moving tracer entity, splash on impact. */
export const MISSILE: WeaponSpec = {
  id: 'missile',
  kind: 'missile',
  damage: 25,
  range: 800,
  fireRate: 0.5,
  energy: 10,
  splashDamage: 12,
  splashRadius: 5,
  speed: 120,
  turnRate: 1.5,
  ttl: 5,
};

/** Weapon id → spec (the v1 armory; the server looks fires up here). */
export const WEAPON_BY_ID: Record<WeaponId, WeaponSpec> = { laser: LASER, missile: MISSILE };

/** True for a valid v1 weapon id (the wire 'fire' payload is validated here). */
export function isWeaponId(value: string): value is WeaponId {
  return value === 'laser' || value === 'missile';
}

/**
 * The class's v1 loadout: which weapons the ship can FIRE (selection is the
 * 1/2 keys; the catalog's mount COUNTS (interceptor: 2 lasers / 4 missiles)
 * are hardpoint balance — one of each kind is active in v1).
 *
 * - scout:       [laser]
 * - interceptor: [laser, missile]
 * - freighter:   [laser]
 */
export function loadoutFor(classId: string): WeaponSpec[] {
  const cls = SHIP_CLASSES[classId as ShipClassId];
  if (!cls) return [];
  const out: WeaponSpec[] = [];
  if (cls.weaponMounts.laser > 0) out.push(LASER);
  if (cls.weaponMounts.missiles > 0) out.push(MISSILE);
  return out;
}

/** True when the class may fire `weaponId` (the server's loadout gate). */
export function hasWeapon(classId: string, weaponId: WeaponId): boolean {
  return loadoutFor(classId).some((w) => w.id === weaponId);
}

// ---------------------------------------------------------------------------
// Energy model (per ship, shared ship state): max 100, regenerating 10/s.
// Denied fires (rate/energy) spend NOTHING; the tick regenerates the rest —
// including while docked (the idle tick keeps regenerating, spec note).
// ---------------------------------------------------------------------------

export const ENERGY_MAX = 100;
export const ENERGY_REGEN_PER_S = 10;

/** Advance the regen (clamped at ENERGY_MAX); the tick's one-liner. */
export function regenEnergy(current: number, dt: number): number {
  return Math.min(ENERGY_MAX, current + ENERGY_REGEN_PER_S * dt);
}

/** True when `energy` can pay `weapon`'s cost (the server's energy gate). */
export function canFire(energy: number, weapon: WeaponSpec): boolean {
  return energy >= (weapon.energy ?? 0);
}

/** Spend an accepted fire's cost (never below zero). */
export function spendEnergy(energy: number, weapon: WeaponSpec): number {
  return Math.max(0, energy - (weapon.energy ?? 0));
}

// ---------------------------------------------------------------------------
// Missile flight (pure): a constant-speed tracer that turns toward its
// target at most `turnRate` rad/s each step. `stepMissile` returns the new
// pos/vel; the caller decides contact (splash radius) and expiry (ttl).
// ---------------------------------------------------------------------------

/**
 * Turn a velocity vector toward `toward` by at most `maxAngle` (the missile
 * turn-rate cap), keeping `magnitude`. A target at zero distance keeps the
 * current heading (no NaNs); a zero-magnitude vector adopts the full step.
 */
export function turnToward(vel: Vec3, toward: Vec3, maxAngle: number, magnitude: number): Vec3 {
  const towardLen = vecLength(toward);
  const curLen = vecLength(vel);
  if (towardLen <= 0) return vel;
  if (curLen <= 0) return vecScale(vecNormalize(toward), magnitude);
  const axis = vecCross(vel, toward);
  const axisLen = vecLength(axis);
  const dot = Math.min(1, Math.max(-1, vecDot(vel, toward) / (curLen * towardLen)));
  const angle = Math.atan2(axisLen, dot); // 0 = aligned, π = opposite
  if (angle <= 1e-9) return vecScale(vel, magnitude);
  const step = Math.min(angle, maxAngle);
  // Rodrigues: rotate `vel` about the (vel × toward) axis by `step`,
  // then pin the magnitude (the missile flies at constant speed).
  const rotated = vecAdd(vecScale(vel, Math.cos(step)), vecScale(axis, Math.sin(step) / axisLen));
  return vecScale(vecNormalize(rotated), magnitude);
}

/**
 * One missile step: turn toward the target (capped), fly at constant speed,
 * advance `dt` seconds. Returns NEW objects (no input mutation).
 */
export function stepMissile(
  pos: Vec3,
  vel: Vec3,
  targetPos: Vec3,
  dt: number,
  speed: number,
  turnRate: number,
): { pos: Vec3; vel: Vec3 } {
  const desired = vecSub(targetPos, pos);
  const nextVel = turnToward(vel, desired, turnRate * dt, speed);
  return {
    pos: vecAdd(pos, { x: nextVel.x * dt, y: nextVel.y * dt, z: nextVel.z * dt }),
    vel: nextVel,
  };
}
