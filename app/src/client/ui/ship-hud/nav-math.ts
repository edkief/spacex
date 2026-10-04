/**
 * Nav readout math (TASK-51) — the pure formatting + bearing functions
 * behind the flight HUD's speed/altitude/regime readouts and the nav
 * arrow.
 *
 * Conventions:
 * - altitude is the world y (u, 1 u ≈ 1 m): the atmosphere boundary math
 *   (shared/physics/atmosphere) treats pos.y exactly as "height above the
 *   surface", so the HUD does too. In SPACE altitude is meaningless — '—'.
 * - the ship's forward (nose) axis is the quat-rotated +Z — the shared
 *   flight model's thrust axis (shared/physics/flight FORWARD), the SAME
 *   axis the flight e2e asserts forward travel along.
 * - the nav arrow is screen-fixed: up = dead ahead of the nose, so the
 *   arrow's CSS rotation is the signed angle from the nose to the target
 *   (positive = target to the RIGHT of the nose). The camera's screen
 *   right for a view along the nose is cross(forward, up) — the same
 *   basis convention as the combat HUD's projection.
 * - in space the bearing is the full 3D vector: the horizontal part
 *   drives the arrow rotation, the vertical part (elevRad, + = above)
 *   drives the arrow's vertical offset (above/below the horizon).
 */
import type { Quat, Vec3 } from '@shared/physics/vec';
import { quatRotateVector, vecLength, vecSub } from '@shared/physics/vec';
import type { Regime } from '@shared/regime';

/** The ship's nose axis: the thrust axis (+Z rotated by the wire quat). */
export function shipForward(rot: Quat): Vec3 {
  return quatRotateVector(rot, { x: 0, y: 0, z: 1 });
}

/** |vel| in m/s (1 u ≈ 1 m). */
export function speedMs(vel: Vec3): number {
  return vecLength(vel);
}

/** '12.3 m/s' — one decimal (spec). */
export function formatSpeed(vel: Vec3): string {
  return `${speedMs(vel).toFixed(1)} m/s`;
}

/** 'ALT 1234 m' in atmosphere/surface; '—' in space (meaningless there). */
export function formatAltitude(regime: Regime, pos: Vec3): string {
  if (regime === 'space') return '—';
  return `ALT ${Math.max(0, Math.round(pos.y))} m`;
}

/** The small regime tag: SPACE / ATMOS / SURFACE (server authority). */
export function regimeTag(regime: Regime): string {
  switch (regime) {
    case 'space':
      return 'SPACE';
    case 'atmosphere':
      return 'ATMOS';
    case 'surface':
      return 'SURFACE';
  }
}

/** '123 m' below 1 km, '12.4 km' at/above (one decimal, spec). */
export function formatDistanceM(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** The nav bearing result: distance + screen arrow angles. */
export interface NavBearing {
  distM: number;
  /** CSS rotation degrees: 0 = arrow up (dead ahead), positive = right. */
  yawDeg: number;
  /** Radians, + = target ABOVE the ship (drives the arrow's lift). */
  elevRad: number;
}

/**
 * Bearing from the ship to a target: the 3D relative vector decomposed
 * into distance, a screen yaw (rotated by the ship's attitude — screen up
 * = the target direction when aligned) and an elevation (the above/below
 * component, meaningful in space). Degenerate cases (zero forward or zero
 * horizontal separation) return a straight-ahead arrow.
 */
export function bearingTo(pos: Vec3, rot: Quat, target: Vec3): NavBearing {
  const to = vecSub(target, pos);
  const distM = vecLength(to);
  const fwd = shipForward(rot);
  const hf = Math.hypot(fwd.x, fwd.z);
  const ht = Math.hypot(to.x, to.z);
  if (hf < 1e-6 || ht < 1e-6) {
    return { distM, yawDeg: 0, elevRad: Math.atan2(to.y, Math.max(ht, 1e-6)) };
  }
  // Screen right for a view along the nose: cross(forward, up), up = +Y.
  const rightX = -fwd.z;
  const rightZ = fwd.x;
  const along = fwd.x * to.x + fwd.z * to.z;
  const side = rightX * to.x + rightZ * to.z;
  const yaw = Math.atan2(side, along);
  return { distM, yawDeg: (yaw * 180) / Math.PI, elevRad: Math.atan2(to.y, ht) };
}

/**
 * The velocity vector's direction relative to the nose, in the same
 * screen convention as bearingTo (for the small thrust vector bar):
 * 0 = moving dead ahead, positive = drifting to the right.
 */
export function thrustYawDeg(vel: Vec3, rot: Quat): number {
  const fwd = shipForward(rot);
  const hf = Math.hypot(fwd.x, fwd.z);
  const hv = Math.hypot(vel.x, vel.z);
  if (hf < 1e-6 || hv < 1e-6) return 0;
  const rightX = -fwd.z;
  const rightZ = fwd.x;
  const along = fwd.x * vel.x + fwd.z * vel.z;
  const side = rightX * vel.x + rightZ * vel.z;
  return (Math.atan2(side, along) * 180) / Math.PI;
}

/** Clamp the arrow's above/below lift (px) from the elevation. */
export function elevLiftPx(elevRad: number, maxPx: number): number {
  const px = (elevRad * 180) / Math.PI; // 1:1 px-per-degree
  return Math.max(-maxPx, Math.min(maxPx, px));
}
