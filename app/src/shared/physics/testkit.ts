import type { Body } from '@shared/physics/bodies.ts';
import type { FlightInput, ShipState } from '@shared/physics/flightTypes.ts';
import { surfaceFrameId } from '@shared/physics/frames.ts';
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
/** The test planet's north and south surface frames. */
export const NORTH = surfaceFrameId(body.id, 'n');
export const SOUTH = surfaceFrameId(body.id, 's');
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

/** Flat terrain at `height` metres with optional pads (flat coordinates). */
export function flatSurface(height = 0, pads: { id: string; x: number; z: number }[] = []) {
  return { heightAt: () => height, pads };
}

/** A ship state at rest in the system frame at `pos`. */
export function restingShip(pos: Vec3, over: Partial<ShipState> = {}): ShipState {
  const base: ShipState = {
    frame: 'system',
    pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: 'space',
  };
  return { ...base, ...over };
}

/** The neutral flight input. */
export const IDLE: FlightInput = {
  thrust: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  up: 0,
  brake: false,
  action: 'none',
};
