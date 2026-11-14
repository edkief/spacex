import type { Body } from '@shared/physics/bodies.ts';
import { add, type Vec3 } from '@shared/physics/vec.ts';

/** Shared fixtures for physics tests: a landable 80 km planet with a 12% atmosphere. */
export const CENTER: Vec3 = { x: 9_000_000, y: 0, z: -4_000_000 };
export const R = 80_000;
export const planet = (over: Partial<Body> = {}): Body => ({
  id: 'abcdef0123456789',
  kind: 'planet',
  center: CENTER,
  radius: R,
  hasSurfaceFrame: true,
  atmosphere: { density: 1, top: 0.12 * R },
  docks: [],
  ...over,
});
export const body = planet();
const SIN = Math.sin;
const COS = Math.cos;

/** System point at colatitude theta, azimuth phi, altitude alt about the test planet. */
export function at(theta: number, phi: number, alt: number): Vec3 {
  const rho = R + alt;
  return add(CENTER, {
    x: rho * SIN(theta) * COS(phi),
    y: rho * COS(theta),
    z: rho * SIN(theta) * SIN(phi),
  });
}
