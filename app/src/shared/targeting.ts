/**
 * Targeting tuning constants — TASK-44 keystone.
 *
 * The v1 lock-on rules (acceptance criteria for TASK-44):
 *
 *   - **Range**: targets must be within `TARGET_LOCK_RANGE_M` (500 m)
 *     of the ship's position. Targets beyond that range cannot be
 *     locked.
 *   - **Cone**: targets must be within `TARGET_LOCK_CONE_HALF_DEG`
 *     (30°) of the ship's forward vector. The cone is the ship's
 *     nose visibility (TASK-43 acceptance: "laser range/LOS"-style
 *     determinism).
 *   - **Auto-release**: the lock auto-releases when any of these
 *     triggers fires:
 *       - target destroyed (`hull <= 0`)
 *       - target exits `TARGET_LOCK_AUTO_RELEASE_RANGE_M` (1500 m)
 *       - `TARGET_LOCK_DURATION_MS` (30 s) elapses since the lock
 *   - **Toggle**: re-pressing T on an already-locked target releases it.
 *   - **Missile preference**: missiles home on the lock if one is
 *     valid, else the fire path picks the nearest-in-cone (30°,
 *     800 m), else the missile flies straight.
 *   - **Threat ping**: a hit/destroyed from `source != self` produces
 *     a 3 s visual ping on the target's HUD.
 *
 * The constants are exported individually so tests can assert
 * boundary behaviour (range-edge cases, cone 30° vs 30.001°,
 * auto-release clocks) without restating numbers in every test.
 */

import type { SimEntity } from "../server/shard/types.js";
import type { Vec3 } from "./physics/vec.js";

/** Lock range — targets farther than this cannot be locked (TASK-44 acceptance). */
export const TARGET_LOCK_RANGE_M = 500;

/** Lock cone half-angle — targets must be within this of forward. */
export const TARGET_LOCK_CONE_HALF_DEG = 30;

/** Lock cone radius in radians for fast trig. */
export const TARGET_LOCK_CONE_HALF_RAD = (TARGET_LOCK_CONE_HALF_DEG * Math.PI) / 180;

/** Cosine of the lock cone (precomputed so the gate avoids acos). */
export const TARGET_LOCK_CONE_COS = Math.cos(TARGET_LOCK_CONE_HALF_RAD);

/** Auto-release when the target exits this range (TASK-44 acceptance). */
export const TARGET_LOCK_AUTO_RELEASE_RANGE_M = 1500;

/** Auto-release when this many ms have passed (TASK-44 acceptance). */
export const TARGET_LOCK_DURATION_MS = 30_000;

/** Missile cone (different from lock — spec: 30°, 800 m). */
export const MISSILE_PICK_CONE_HALF_DEG = 30;
export const MISSILE_PICK_RANGE_M = 800;

/** Missile cone radius in radians. */
export const MISSILE_PICK_CONE_HALF_RAD = (MISSILE_PICK_CONE_HALF_DEG * Math.PI) / 180;
export const MISSILE_PICK_CONE_COS = Math.cos(MISSILE_PICK_CONE_HALF_RAD);

/** Threat-ping decay window (TASK-44 acceptance: "fades after 3 s"). */
export const THREAT_PING_TTL_MS = 3_000;

/**
 * Threat-ping "strongest recent source wins" window — within this
 * many ms, the most recent attacker is the one shown (TASK-44
 * acceptance).
 */
export const THREAT_PING_RECENT_MS = 5_000;

// ---------------------------------------------------------------------------
// Pure helpers — no shard dependency, safe for client + server + tests
// ---------------------------------------------------------------------------

/**
 * Cosine of the half-angle of the ship-nose cone for a target.
 *
 * Returns `cos(angle between target-direction and ship-forward)`
 * where the ship's forward is derived from its quaternion.
 *
 * Convention: forward is `quatRotate(quat, +Z)`; the rotation math
 * matches `forwardOf` in `@server/shard/weapons.ts` so the same
 * convention decides "in front" for locks, missile picks, and the
 * laser damagePoint.
 */
export function angleCosineToForward(ship: SimEntity, target: SimEntity): number {
  const dx = target.pos.x - ship.pos.x;
  const dy = target.pos.y - ship.pos.y;
  const dz = target.pos.z - ship.pos.z;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dLen < 1e-6) return 1; // target on top of ship → cos = 1 (degenerate).
  const forward = forwardVecFromQuat(ship.quat);
  // forward · dir
  return (forward.x * dx + forward.y * dy + forward.z * dz) / dLen;
}

/**
 * Forward unit vector for a ship given its orientation. Mirrors the
 * math in `weapons.ts#forwardOf` but returns the unit vector rather
 * than a translated point.
 */
export function forwardVecFromQuat(quat: SimEntity["quat"]): Vec3 {
  const { x, y, z, w } = quat;
  // forward = quat * (0,0,1) * conj(quat) — expanded:
  const vx = 2 * (x * z - y * w);
  const vy = 2 * (y * z + x * w);
  const vz = 1 - 2 * (x * x + y * y);
  const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (vLen < 1e-6) return { x: 0, y: 0, z: 1 };
  return { x: vx / vLen, y: vy / vLen, z: vz / vLen };
}

/**
 * Test whether `target` is within the lock range AND within the
 * lock cone of `ship`. Used both to gate `target_lock` and to gate
 * auto-release (range check only — target lock can't have a target
 * exit the cone because the cone is forward-fixed).
 *
 * Treats a destroyed target (`hull <= 0`) as not lockable, so the
 * smoke-test for the lock UI doesn't render an invalid box.
 *
 * Treats non-ship entities (deposits / stations / terminals / ground
 * items) as not lockable per TASK-44 acceptance ("ships only — no
 * target lock on deposits/stations in v1").
 */
export function isLockableTarget(
  ship: SimEntity,
  target: SimEntity,
  rangeM: number = TARGET_LOCK_RANGE_M,
  coneCos: number = TARGET_LOCK_CONE_COS,
): boolean {
  if (target.id === ship.id) return false; // can't lock self
  if (target.kind !== "player" && target.kind !== "ai") return false; // ships only
  if (target.hull <= 0) return false; // destroyed
  // Range gate.
  const dx = target.pos.x - ship.pos.x;
  const dy = target.pos.y - ship.pos.y;
  const dz = target.pos.z - ship.pos.z;
  const dSq = dx * dx + dy * dy + dz * dz;
  if (dSq > rangeM * rangeM) return false;
  // Cone gate.
  const cos = angleCosineToForward(ship, target);
  return cos >= coneCos;
}

/**
 * Project the target's bearing (relative angle from the ship's
 * forward) onto the horizontal plane around the ship's nose, in
 * degrees. Positive = right of forward, negative = left, on a
 * wrap to `[-180, 180]`.
 *
 * Helper for the threat-ping indicator math (used by both server
 * and client to keep the convention).
 */
export function bearingDegrees(ship: SimEntity, target: SimEntity): number {
  const forward = forwardVecFromQuat(ship.quat);
  const dx = target.pos.x - ship.pos.x;
  const dy = target.pos.y - ship.pos.y;
  const dz = target.pos.z - ship.pos.z;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dLen < 1e-6) return 0;
  const dot = (forward.x * dx + forward.y * dy + forward.z * dz) / dLen;
  const clamped = Math.max(-1, Math.min(1, dot));
  // Use the lateral component of the target direction for the
  // sign of bearing: cross(forward, targetDir) · up.
  // We assume a uniform "up" of +Y, since ship-side angle on the
  // XZ plane projects the bearing back to [-180, 180].
  const crossY = forward.x * dz - forward.z * dx;
  const radians = Math.acos(clamped);
  const signed = crossY < 0 ? -radians : radians;
  return (signed * 180) / Math.PI;
}

/**
 * Distance helper (m) — flat root-distance, good enough for the
 * 500 / 800 / 1500 m ranges the spec quotes.
 */
export function distanceM(
  a: { pos: { x: number; y: number; z: number } },
  b: {
    pos: { x: number; y: number; z: number };
  },
): number {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const dz = a.pos.z - b.pos.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
