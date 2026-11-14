import { softCapSpeed } from './travel.ts';
import { length, scale, type Vec3 } from './vec.ts';

/** Limits a command vector to magnitude 1. */
export function clampMagnitude(v: Vec3): Vec3 {
  const m = length(v);
  return m > 1 ? scale(v, 1 / m) : v;
}

/** Reduces |v| by up to `amount` m/s (retro braking), never reversing it. */
export function brakeBy(v: Vec3, amount: number): Vec3 {
  const speed = length(v);
  if (speed === 0) return v;
  return scale(v, Math.max(0, speed - amount) / speed);
}

/** Applies the soft speed cap (excess decays toward `cap`) to a velocity. */
export function capVelocity(v: Vec3, cap: number, dt: number): Vec3 {
  const speed = length(v);
  return speed > 0 ? scale(v, softCapSpeed(speed, cap, dt) / speed) : v;
}
