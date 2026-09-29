import type { SpectralClass } from './types.js';

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
 * Log-normal galaxy-disk radius in galactic units, clamped to
 * [0, GALAXY_RADIUS]. Thin z is applied by the caller.
 */
export function diskRadius(rng: { nextGauss(mean?: number, sd?: number): number }): number {
  const r = Math.exp(rng.nextGauss(DISK_RADIUS_MEAN_LN, DISK_RADIUS_SD_LN));
  return Math.min(r, GALAXY_RADIUS);
}
