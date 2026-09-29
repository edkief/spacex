import type { PlanetClass, ShipClassId, SpectralClass } from './types.js';

/** Default number of stars per galaxy (configurable via generateStars). */
export const GALAXY_STAR_COUNT = 200;

/** Max galactic radius for any star (galactic units). */
export const GALAXY_RADIUS = 1000;

/** Max |z| for any star: the disk is thin. */
export const GALAXY_THICKNESS = 40;

/** Log-normal radius parameters (natural log of galactic units). */
const DISK_RADIUS_MEAN_LN = Math.log(180);
const DISK_RADIUS_SD_LN = 0.55;

/**
 * Relative spectral-class weights (sum 100). Skewed like a real galaxy:
 * O stars are rare, K/M dwarfs dominate.
 */
export const SPECTRAL_WEIGHTS: readonly [SpectralClass, number][] = [
  ['O', 1],
  ['B', 5],
  ['A', 10],
  ['F', 15],
  ['G', 20],
  ['K', 28],
  ['M', 21],
];

/** Name prefixes (40+). Combined seeded: prefix + root + suffix. */
export const NAME_PREFIXES: readonly string[] = [
  'Vel',
  'Kor',
  'Aza',
  'Thal',
  'Ny',
  'Vor',
  'Syr',
  'Quel',
  'Dran',
  'Isha',
  'Bel',
  'Oren',
  'Cal',
  'Mira',
  'Zeth',
  'Urd',
  'Fen',
  'Sola',
  'Tavi',
  'Ner',
  'Ald',
  'Rho',
  'Cael',
  'Drev',
  'Elan',
  'Gor',
  'Hale',
  'Ivo',
  'Jor',
  'Kael',
  'Lys',
  'Mor',
  'Nyx',
  'Orin',
  'Pel',
  'Ryn',
  'Sar',
  'Tor',
  'Ulm',
  'Vex',
  'Wyn',
  'Xel',
  'Yan',
  'Zir',
  'Ash',
  'Brin',
];

/** Name roots (40+), all lowercase. */
export const NAME_ROOTS: readonly string[] = [
  'ar',
  'ion',
  'eth',
  'ora',
  'um',
  'is',
  'an',
  'os',
  'ea',
  'yr',
  'ad',
  'ol',
  'un',
  'ir',
  'ax',
  'en',
  'olm',
  'a',
  'us',
  'ith',
  'ov',
  'el',
  'ur',
  'ay',
  'ind',
  'ess',
  'yn',
  'al',
  'or',
  'e',
  'ix',
  'om',
  'oy',
  'ura',
  'ine',
  'ell',
  'ard',
  'ari',
  'ien',
  'oth',
  'una',
  'ire',
  'eld',
  'ant',
];

/** Name suffixes (40+), all leading-spaced so names read as phrases. */
export const NAME_SUFFIXES: readonly string[] = [
  ' Prime',
  ' Minor',
  ' Major',
  ' Expanse',
  ' Reach',
  ' Gate',
  ' Spire',
  ' Fall',
  ' Rest',
  ' Keep',
  ' Port',
  ' Field',
  ' Shore',
  ' Vault',
  ' Crown',
  ' Veil',
  ' Hallow',
  ' Bough',
  ' Ford',
  ' Point',
  ' Rise',
  ' Hollow',
  ' March',
  ' Ward',
  ' Glen',
  ' Heath',
  ' Moor',
  ' Strand',
  ' Deneb',
  ' Cygnar',
  ' Rigel',
  ' Altair',
  ' Vega',
  ' Duma',
  ' Khor',
  ' Zent',
  ' Maris',
  ' Osha',
  ' Tavi',
  ' Elum',
  ' Anor',
  ' Irix',
];

/**
 * Relative planet-class weights (sum 100) used by the system generator.
 * Gas giants are moderately common; rocky worlds dominate.
 */
export const PLANET_CLASS_WEIGHTS: ReadonlyArray<readonly [PlanetClass, number]> = [
  ['rocky', 32],
  ['terran', 18],
  ['ice', 20],
  ['ocean', 12],
  ['gas', 18],
];

/** Per-class chance that a planet has an atmosphere. Gas giants do. */
export const PLANET_ATMOSPHERE_CHANCE: Record<PlanetClass, number> = {
  terran: 0.9,
  ocean: 1,
  rocky: 0.6,
  ice: 0.75,
  gas: 0.6,
};

/** Per-class chance that a non-gas planet is landable (gas is never). */
export const PLANET_LANDABLE_CHANCE: Record<PlanetClass, number> = {
  terran: 0.9,
  ocean: 0.8,
  rocky: 0.8,
  ice: 0.7,
  gas: 0,
};

/** Surface deposit resource type fields present on planets (TASK-4). */
export const RESOURCE_TYPES: readonly string[] = [
  'iron',
  'copper',
  'silicon',
  'rare-earths',
  'water',
  'gas-compounds',
];

/** Rogue-AI ship class ids (must match the TASK-19 catalog). */
export const SHIP_CLASS_IDS: readonly ShipClassId[] = ['scout', 'freighter', 'interceptor'];

/**
 * Log-normal galaxy-disk radius in galactic units, clamped to
 * [0, GALAXY_RADIUS]. Thin z is applied by the caller.
 */
export function diskRadius(rng: { nextGauss(mean?: number, sd?: number): number }): number {
  const r = Math.exp(rng.nextGauss(DISK_RADIUS_MEAN_LN, DISK_RADIUS_SD_LN));
  return Math.min(r, GALAXY_RADIUS);
}
