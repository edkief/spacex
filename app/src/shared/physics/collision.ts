import type { Body } from './bodies.ts';
import { CONTACT_MARGIN_M } from './flightConstants.ts';
import { add, dot, normalize, scale, sub, type Vec3 } from './vec.ts';

export interface Contact {
  pos: Vec3;
  /** Outward surface normal at the contact. */
  normal: Vec3;
}

/**
 * Swept-sphere test: the first body a ship's straight step from `from` to `to` would pass
 * into. Landable planets are solid to the datum sphere here (their terrain is handled in the
 * surface frame, which a ship always enters well above the ground). Exact for any step length, so no speed can tunnel through a planet. A start point already
 * inside a body is pushed straight out. Returns undefined when the step is clear.
 */
export function sweepBodies(from: Vec3, to: Vec3, bodies: readonly Body[]): Contact | undefined {
  const d = sub(to, from);
  const a = dot(d, d);
  let best: { t: number; body: Body; radius: number } | undefined;
  for (const body of bodies) {
    const radius = body.radius;
    const rel = sub(from, body.center);
    const c = dot(rel, rel) - radius * radius;
    if (c <= 0) {
      // Starting inside: resolve by projecting out along the radial direction from `to`.
      const outward = normalize(sub(to, body.center));
      return { pos: add(body.center, scale(outward, radius + CONTACT_MARGIN_M)), normal: outward };
    }
    if (a === 0) continue;
    const b = 2 * dot(d, rel);
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t >= 0 && t <= 1 && (!best || t < best.t)) best = { t, body, radius };
  }
  if (!best) return undefined;
  const hit = add(from, scale(d, best.t));
  const normal = normalize(sub(hit, best.body.center));
  return { pos: add(best.body.center, scale(normal, best.radius + CONTACT_MARGIN_M)), normal };
}

/** Removes the velocity component pointing into a surface with outward `normal`. */
export function slideVelocity(vel: Vec3, normal: Vec3): Vec3 {
  const into = dot(vel, normal);
  return into < 0 ? sub(vel, scale(normal, into)) : vel;
}
