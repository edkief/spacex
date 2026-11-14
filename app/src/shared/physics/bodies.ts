import type { SystemGen } from '../galaxy/types.ts';
import type { Vec3 } from './vec.ts';
import { FRAME_SWITCH_MARGIN_M, FRAME_SWITCH_MIN_ALTITUDE_M } from './worldConstants.ts';

export interface BodyDock {
  id: string;
  padId: string;
  position: Vec3;
}

/**
 * A solid sphere of the system: the star or a planet. Planets do not move or rotate. Only
 * landable planets have a surface frame; the star, gas giants and unlandable planets are solid.
 */
export interface Body {
  /** 16-hex planet id, or `'star'`. */
  id: string;
  kind: 'star' | 'planet';
  center: Vec3;
  /** Sim radius in metres. */
  radius: number;
  /** True when the body has a surface frame (a landable planet). */
  hasSurfaceFrame: boolean;
  /** Atmosphere density (relative to terran) and top altitude in metres; null when none. */
  atmosphere: { density: number; top: number } | null;
  docks: readonly BodyDock[];
}

/** Altitude below which a ship is moved into the planet's surface frame. */
export function frameSwitchAltitude(body: Body): number {
  const top = body.atmosphere ? body.atmosphere.top : 0;
  return Math.max(top + FRAME_SWITCH_MARGIN_M, FRAME_SWITCH_MIN_ALTITUDE_M);
}

/**
 * Altitude below which the `atmosphere` regime applies: the atmosphere top, or for airless
 * planets the same low band as the frame switch altitude (with zero drag).
 */
export function regimeBandTop(body: Body): number {
  return body.atmosphere ? body.atmosphere.top : FRAME_SWITCH_MIN_ALTITUDE_M;
}

/** Builds the solid bodies (star first, then planets in orbit order) of a generated system. */
export function bodiesOf(system: SystemGen): Body[] {
  const star: Body = {
    id: 'star',
    kind: 'star',
    center: { x: 0, y: 0, z: 0 },
    radius: system.star.radius,
    hasSurfaceFrame: false,
    atmosphere: null,
    docks: [],
  };
  const planets = system.planets.map((planet): Body => ({
    id: planet.id,
    kind: 'planet',
    center: planet.position,
    radius: planet.simRadius,
    hasSurfaceFrame: planet.landable,
    atmosphere: planet.atmosphere
      ? {
          density: planet.atmosphere.density,
          top: planet.atmosphere.topFraction * planet.simRadius,
        }
      : null,
    docks: planet.docks,
  }));
  return [star, ...planets];
}
