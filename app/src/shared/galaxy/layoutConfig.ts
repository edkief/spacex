import type { PlanetClass, StarClass } from './types.ts';

/** Sim scale: a planet's sim radius in metres is `radiusKm * SIM_METRES_PER_KM` (1:100 scale). */
export const SIM_METRES_PER_KM = 10;

/** Innermost orbit radius (system frame, metres) is 8,000 km (sim) plus up to 2,000 km of jitter. */
export const INNERMOST_ORBIT_M = 8_000_000;
export const INNERMOST_ORBIT_JITTER_M = 2_000_000;
/** Each next orbit lies 6,000-20,000 km (sim) further out. */
export const ORBIT_GAP_MIN_M = 6_000_000;
export const ORBIT_GAP_MAX_M = 20_000_000;

/** Docks are orbital platforms at 1.6 planet radii from the planet centre. */
export const DOCK_ORBIT_FACTOR = 1.6;
/** Two docks of one planet must differ by at least ~26 degrees (dot product <= 0.9) if possible. */
export const DOCK_MAX_DOT = 0.9;
export const DOCK_PLACEMENT_ATTEMPTS = 48;

/** Star radius by spectral class in metres (sim scale; always well inside the innermost orbit). */
export const STAR_RADIUS_M: Readonly<Record<StarClass, number>> = {
  O: 5_000_000,
  B: 4_000_000,
  A: 3_200_000,
  F: 2_600_000,
  G: 2_000_000,
  K: 1_500_000,
  M: 1_000_000,
};

/** The atmosphere reaches this fraction of the planet radius above the surface. */
export const ATMOSPHERE_TOP_FRACTION = 0.12;

/**
 * Relative atmosphere density per planet class (1.0 is the terran reference). Used when the
 * planet `hasAtmosphere`; drag scales linearly with it.
 */
export const ATMOSPHERE_DENSITY: Readonly<Record<PlanetClass, number>> = {
  terran: 1,
  ocean: 1.2,
  rocky: 0.5,
  ice: 0.4,
  gas: 3,
};

/** Salts keeping layout draws independent of every earlier draw of the generators. */
export const LAYOUT_SALT = 0x6c61796f7574n;
export const DOCK_SALT = 0x646f636bn;
export const DOCK_ID_SALT = 0x646f636b6964n;
export const PAD_SALT = 0x706164n;
