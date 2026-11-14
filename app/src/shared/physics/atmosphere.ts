import { ATMOSPHERE_RAMP_M, DRAG_COEFFICIENT } from './flightConstants.ts';
import { dot, scale, type Vec3 } from './vec.ts';

/**
 * Atmosphere boundary factor in [0, 1]: 0 at and above the atmosphere top, rising linearly to 1
 * at `ramp` metres below it. Both drag and gravity are multiplied by it, so crossing the boundary
 * changes accelerations continuously (the single shared ramp of TASK-22/TASK-28).
 */
export function boundaryFactor(altitude: number, top: number, ramp = ATMOSPHERE_RAMP_M): number {
  if (top <= 0) return 0;
  return Math.min(1, Math.max(0, (top - altitude) / Math.min(ramp, top)));
}

/** Full drag coefficient k (1/m) for a ship of `mass` kg in air of relative `density`. */
export function dragCoefficient(density: number, mass: number): number {
  return DRAG_COEFFICIENT * density * Math.pow(mass, -1 / 3);
}

/** Drag acceleration `-k |v| v` (m/s^2) for coefficient `k` (already scaled by the boundary). */
export function dragAcceleration(velocity: Vec3, k: number): Vec3 {
  return scale(velocity, -k * Math.sqrt(dot(velocity, velocity)));
}

/** Closed-form speed under constant quadratic drag with no other forces: v0 / (1 + k v0 t). */
export function dragSpeedAt(v0: number, k: number, t: number): number {
  return v0 / (1 + k * v0 * t);
}
