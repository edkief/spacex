import type { Body } from './bodies.ts';
import { colatitude } from './frames.ts';
import { CONTACT_MARGIN_M } from './flightConstants.ts';
import { add, dot, normalize, scale, sub, type Vec3 } from './vec.ts';
import { MAX_COLATITUDE, MAX_TERRAIN_HEIGHT_M } from './worldConstants.ts';

export interface Contact {
  pos: Vec3;
  /** Outward surface normal at the contact. */
  normal: Vec3;
}

/**
 * Effective solid radius of a body for a system-frame segment. Landable planets are solid only
 * to the datum sphere (terrain lives in the surface frame), except in the south polar cap beyond
 * 0.97 pi, which has no surface frame and is closed off by a shell at the maximum terrain height.
 */
function solidRadius(body: Body, from: Vec3, to: Vec3): number {
  if (!body.hasSurfaceFrame) return body.radius;
  const cap = colatitude(body, from) > MAX_COLATITUDE || colatitude(body, to) > MAX_COLATITUDE;
  return cap ? body.radius + MAX_TERRAIN_HEIGHT_M : body.radius;
}

/**
 * Swept-sphere test: the first solid body a ship's straight step from `from` to `to` would pass
 * into. Exact for any step length, so no speed can tunnel through a planet. A start point already
 * inside a body is pushed straight out. Returns undefined when the step is clear.
 */
export function sweepBodies(from: Vec3, to: Vec3, bodies: readonly Body[]): Contact | undefined {
  const d = sub(to, from);
  const a = dot(d, d);
  let best: { t: number; body: Body; radius: number } | undefined;
  for (const body of bodies) {
    const radius = solidRadius(body, from, to);
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
