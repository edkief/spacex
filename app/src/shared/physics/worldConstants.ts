/**
 * World-model constants shared by client and server sim code. Units: metres, seconds,
 * kilograms, radians. Layout constants (orbits, docks, star radii, atmosphere table) live in
 * `galaxy/layoutConfig.ts` because they drive generation.
 */

/** Surface frames switch in below `max(atmosphere top + 1 km, 3 km)` of altitude. */
export const FRAME_SWITCH_MARGIN_M = 1000;
export const FRAME_SWITCH_MIN_ALTITUDE_M = 3000;
/** Leaving a surface frame needs altitude above this multiple of the switch altitude. */
export const FRAME_EXIT_FACTOR = 1.1;

/** Colatitudes beyond this are out of range of the surface projection (the singular antipode). */
export const MAX_COLATITUDE = 0.97 * Math.PI;
/** Terrain never exceeds this height above the datum; the south polar cap is a shell at this height. */
export const MAX_TERRAIN_HEIGHT_M = 400;
