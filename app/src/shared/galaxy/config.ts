import type { StarClass } from './types.ts';

export const GALAXY_STAR_COUNT = 200;
/** Disk radius in galactic units; star x/y always lie within it. */
export const GALAXY_RADIUS = 500;
/** Fraction of the radius kept clear at the centre. */
export const GALAXY_INNER_FRACTION = 0.12;
/** Standard deviation of star height above/below the disk plane (bounded at 6 sd). */
export const GALAXY_THICKNESS_SD = 18;
export const MIN_SYSTEM_COUNT = 2;
export const MAX_SYSTEM_COUNT = 8;

/** Spectral classes with relative weights: hot O stars are rare, K and M dwarfs common. */
export const STAR_CLASSES: readonly StarClass[] = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
export const STAR_CLASS_WEIGHTS: readonly number[] = [1, 4, 10, 25, 45, 80, 135];
