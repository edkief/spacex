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

/**
 * A ship in a surface chart moves to the other hemisphere's chart once it is this far past the
 * equator, measured as the sine of its latitude beyond it. 0.0488 corresponds to chart radius
 * r = 1.05, so it arrives in the other chart at r = 0.95: hysteresis against flapping.
 */
export const CHART_SWITCH_SIN_LATITUDE = 0.0488;
/** Terrain never exceeds this height above the datum. */
export const MAX_TERRAIN_HEIGHT_M = 400;
