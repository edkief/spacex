import { regimeBandTop, type Body } from './physics/bodies.ts';
import { SYSTEM_FRAME, type FrameId } from './physics/frames.ts';

/** The one regime definition; the protocol's `regime` field is built from this list. */
export const REGIMES = ['space', 'atmosphere', 'surface'] as const;
export type Regime = (typeof REGIMES)[number];

/** Hysteresis on the space <-> atmosphere boundary, in metres. */
export const REGIME_HYSTERESIS_M = 50;
/** Atmosphere -> surface: below this height above terrain while slower than `SURFACE_ENTER_SPEED`. */
export const SURFACE_ENTER_HEIGHT_M = 2;
export const SURFACE_ENTER_SPEED = 5;
/** Surface -> atmosphere: above this height above terrain, or faster than `SURFACE_EXIT_SPEED`. */
export const SURFACE_EXIT_HEIGHT_M = 5;
export const SURFACE_EXIT_SPEED = 15;

export interface RegimeInput {
  /** The entity's regime on the previous resolution (`'space'` for a new entity). */
  previous: Regime;
  /** Frame the entity is in; the system frame is always `'space'`. */
  frame: FrameId;
  /** The planet whose surface frame the entity is in (undefined in the system frame). */
  planet: Body | undefined;
  /** Altitude above the datum sphere (the flat frame's y), metres. */
  altitude: number;
  /** Terrain height above the datum at the entity's position, metres. */
  terrainHeight: number;
  /** Speed in m/s. */
  speed: number;
}

/**
 * Resolves an entity's regime. Pure and shared by client and server. Rules (one step per call):
 * - space -> atmosphere when altitude drops below the atmosphere top (airless planets: the 3 km
 *   low-altitude band); atmosphere -> space only above top + 50 m (hysteresis);
 * - atmosphere -> surface below terrain + 2 m while slower than 5 m/s; surface -> atmosphere above
 *   terrain + 5 m or faster than 15 m/s;
 * - never space <-> surface directly (a jump is resolved over successive calls);
 * - the system frame is always space.
 */
export function resolveRegime(input: RegimeInput): Regime {
  const { previous, frame, planet, altitude, terrainHeight, speed } = input;
  if (frame === SYSTEM_FRAME || !planet) return previous === 'surface' ? 'atmosphere' : 'space';

  const top = regimeBandTop(planet);
  const height = altitude - terrainHeight;
  switch (previous) {
    case 'space':
      return altitude < top ? 'atmosphere' : 'space';
    case 'atmosphere':
      if (altitude > top + REGIME_HYSTERESIS_M) return 'space';
      return height < SURFACE_ENTER_HEIGHT_M && speed < SURFACE_ENTER_SPEED
        ? 'surface'
        : 'atmosphere';
    case 'surface':
      return height > SURFACE_EXIT_HEIGHT_M || speed > SURFACE_EXIT_SPEED
        ? 'atmosphere'
        : 'surface';
  }
}
