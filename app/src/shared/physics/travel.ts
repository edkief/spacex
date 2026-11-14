import type { Body } from './bodies.ts';
import {
  SOFT_CAP_DECAY_PER_S,
  TRAVEL_MAX_FACTOR,
  TRAVEL_SCALE_DISTANCE_M,
} from './flightConstants.ts';
import { distance, type Vec3 } from './vec.ts';

/** Travel scale factor f(d) = 1 + d / D (capped at F_MAX) for distance `d` to the nearest surface. */
export function speedFactor(d: number): number {
  return Math.min(1 + Math.max(0, d) / TRAVEL_SCALE_DISTANCE_M, TRAVEL_MAX_FACTOR);
}

/**
 * Distance from a system-frame point to the nearest body surface or dock point (docks count as
 * zero-radius bodies so the cap also falls to catalog stats near them).
 */
export function distanceToNearest(pos: Vec3, bodies: readonly Body[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const body of bodies) {
    nearest = Math.min(nearest, distance(pos, body.center) - body.radius);
    for (const dock of body.docks) nearest = Math.min(nearest, distance(pos, dock.position));
  }
  return Math.max(0, nearest);
}

/**
 * Soft speed cap: speed above `cap` decays exponentially toward it (rate SOFT_CAP_DECAY_PER_S),
 * independent of the step size. Returns the new speed; never below `cap` unless already lower.
 */
export function softCapSpeed(speed: number, cap: number, dt: number): number {
  if (speed <= cap) return speed;
  return cap + (speed - cap) * Math.exp(-SOFT_CAP_DECAY_PER_S * dt);
}
