/**
 * Atmosphere boundary (TASK-22, shared with TASK-28).
 *
 * The flight model must not step into/out of drag at a hard altitude line:
 * the drag coefficient ramps 0 → k linearly across the 1 km boundary band
 * above the terrain, so a ship crossing the boundary under constant input
 * experiences a continuous (C⁰) change in drag, never a velocity kick.
 *
 * TASK-28 (system boundary streaming) must import `atmosphereFactor` /
 * `ATMOSPHERE_BOUNDARY_M` from here — do not re-implement the ramp.
 */

/** Altitude (in u, 1 u ≈ 1 m) at which full atmospheric drag applies. */
export const ATMOSPHERE_BOUNDARY_M = 1000;

/**
 * Drag multiplier for a given altitude above terrain.
 * 0 at/below ground, linear 0→1 across the 1 km boundary, 1 above it.
 * Continuous everywhere; only linear pieces.
 */
export function atmosphereFactor(altitudeU: number): number {
  if (altitudeU <= 0) return 0;
  if (altitudeU >= ATMOSPHERE_BOUNDARY_M) return 1;
  return altitudeU / ATMOSPHERE_BOUNDARY_M;
}
