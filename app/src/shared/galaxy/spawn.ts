/**
 * Inter-system spawn gate (TASK-8).
 *
 * When a ship warps into a system it arrives at the system's spawn gate: a
 * fixed offset from the system star. The in-system star always sits at the
 * origin (world coordinates are system-relative), so the gate is a pure
 * constant — deterministic for tests, no seed stream to coordinate.
 *
 * Geometry (spec technical note): 100 u from the star along the +X axis,
 * facing the star. The flight model's forward axis is +Z (see
 * @shared/physics/flight), so "facing the star" is the quaternion that maps
 * +Z to −X: a −90° rotation about Y.
 */

import { quatRotateVector } from '../physics/vec';
import type { Quat } from '../physics/vec';

/** Gate distance from the star, in world units. */
export const SPAWN_GATE_DISTANCE_U = 100;

/** Gate position: `SPAWN_GATE_DISTANCE_U` along +X from the star at origin. */
export const SPAWN_GATE_POS = {
  x: SPAWN_GATE_DISTANCE_U,
  y: 0,
  z: 0,
} as const;

/**
 * Orientation of a ship arriving at the gate: forward (+Z) aimed at the
 * star at the origin (i.e. toward −X). Precomputed as a −90° yaw so the
 * value is the same constant everywhere (server warp handler, client world).
 */
export const SPAWN_GATE_QUAT: Quat = (() => {
  const half = Math.PI / 4; // θ/2 for θ = −90° about Y
  const quat: Quat = { x: 0, y: -Math.sin(half), z: 0, w: Math.cos(half) };
  // Sanity: this constant must map the forward axis onto −X.
  const forward = quatRotateVector(quat, { x: 0, y: 0, z: 1 });
  if (Math.abs(forward.x + 1) > 1e-9 || Math.abs(forward.z) > 1e-9) {
    throw new Error('SPAWN_GATE_QUAT does not face the star');
  }
  return quat;
})();

/** The full spawn-gate pose (position + orientation) a warping ship gets. */
export function spawnGatePose(): { pos: { x: number; y: number; z: number }; quat: Quat } {
  return { pos: { ...SPAWN_GATE_POS }, quat: { ...SPAWN_GATE_QUAT } };
}
