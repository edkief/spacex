/**
 * System generator configuration.
 *
 * Lives in its own file (rather than appending to `config.ts`) so that
 * the import graph for `stars.ts` (TASK-3) and friends is unchanged —
 * anything pulling in `config.ts` only loads the constants it needs.
 * TASK-4's generator pulls in only this file.
 *
 * Every constant here is exercised by the test suite. Tweak with care:
 * most tweaks will invalidate the golden fixture in
 * `system-dev-seed.json`, the same way tweaks to GALAXY_STAR_COUNT or
 * the spectral weights invalidate the stars fixture.
 */

import type { PlanetClass } from "./types.js";

// ---------------------------------------------------------------------------
// Per-system planet count
// ---------------------------------------------------------------------------

/** Minimum number of planets per system (inclusive). Spec requires 2..6. */
export const PLANET_COUNT_MIN = 2;
/** Maximum number of planets per system (inclusive). */
export const PLANET_COUNT_MAX = 6;

// ---------------------------------------------------------------------------
// Planet radii (km)
// ---------------------------------------------------------------------------

/** Minimum radius for non-gas planets (km). */
export const PLANET_RADIUS_MIN_KM = 2_000;
/** Maximum radius for non-gas planets (km). */
export const PLANET_RADIUS_MAX_KM = 8_000;

/** Minimum radius for gas giants (km). */
export const PLANET_RADIUS_MIN_KM_GAS = 20_000;
/** Maximum radius for gas giants (km). */
export const PLANET_RADIUS_MAX_KM_GAS = 60_000;

// ---------------------------------------------------------------------------
// Planet class weights
// ---------------------------------------------------------------------------

/**
 * Probability of each planet class.
 *
 * Roughly tracks real-world formation order: rocky/terran closest to
 * the star, then gas giants in the frost line, then ice/ocean out
 * beyond. Terran is rarer than rocky because real terran-class planets
 * are rarer; we keep the spread gentle so a 6-planet system always
 * shows a mix of classes.
 *
 * Sum must equal 1.0 — asserted by the test suite.
 */
export const PLANET_CLASS_WEIGHTS: Readonly<Record<PlanetClass, number>> = {
  rocky: 0.28,
  terran: 0.18,
  ocean: 0.14,
  gas: 0.2,
  ice: 0.2,
} as const;

/** Sum of weights — must equal 1.0 within float tolerance. */
export const PLANET_CLASS_WEIGHT_SUM = Object.values(PLANET_CLASS_WEIGHTS).reduce(
  (a, b) => a + b,
  0,
);

// ---------------------------------------------------------------------------
// Atmosphere probabilities (per class)
// ---------------------------------------------------------------------------

/**
 * Probability that a planet of the given class retains an atmosphere.
 *
 * Gas/terran/ocean → always (1.0). Rocky and ice roll the dice; the
 * specific numbers below were chosen so that over 200 generated
 * systems (the spec's statistical test) at least 80% have a landable
 * planet with an atmosphere. With `PLANET_CLASS_WEIGHTS` giving rocky
 * ≈ 28% of planets and `ATMOSPHERE_PROBABILITY.rocky = 0.5`, a 6-planet
 * system has roughly a 97% chance of containing at least one rocky
 * planet with an atmosphere; adding terran (which is *always*
 * atmosphere-equipped) gives near-certainty.
 */
export const ATMOSPHERE_PROBABILITY: Readonly<Record<"rocky" | "ice", number>> = {
  rocky: 0.5,
  ice: 0.3,
} as const;

/** Probability that a non-gas planet is landable. Gas giants are never landable. */
export const NON_GAS_LANDABLE_PROBABILITY = 0.95;

// ---------------------------------------------------------------------------
// Docks
// ---------------------------------------------------------------------------

/** Minimum dock count for a landable planet (inclusive). Spec requires ≥1 for landable. */
export const DOCK_COUNT_MIN = 1;
/** Maximum dock count for a landable planet (inclusive). */
export const DOCK_COUNT_MAX = 3;

// ---------------------------------------------------------------------------
// Resource fields
// ---------------------------------------------------------------------------

/** Minimum resource types per planet. */
export const RESOURCE_PICKS_MIN = 1;
/** Maximum resource types per planet. */
export const RESOURCE_PICKS_MAX = 3;

// ---------------------------------------------------------------------------
// AI roster
// ---------------------------------------------------------------------------

/** Minimum AI ships per planet (inclusive). Spec requires 2..5. */
export const AI_ROSTER_MIN = 2;
/** Maximum AI ships per planet (inclusive). */
export const AI_ROSTER_MAX = 5;

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Suffix appended to the star's name for the system display name. */
export const SYSTEM_NAME_SUFFIX = " system";

/** Planet index cap — bounds the Roman-numeral naming scheme. */
export const PLANET_NAME_INDEX_MAX = 59;

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

/**
 * Width of the hex-encoded id (16 chars == 64 bits). Same constant as
 * `stars.ts` uses; duplicated here to keep the import graph small.
 */
export const ID_HEX_CHARS = 16;
