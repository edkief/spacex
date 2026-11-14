import type { PlanetClass } from './types.ts';

export const MIN_PLANETS = 2;
export const MAX_PLANETS = 6;
export const MIN_AI_COUNT = 2;
export const MAX_AI_COUNT = 5;
export const MAX_DOCKS = 3;
export const MAX_RESOURCE_TYPES = 3;

export const RESOURCE_TYPES = [
  'iron',
  'copper',
  'silicon',
  'rare-earths',
  'water',
  'gas-compounds',
] as const;

export const PLANET_CLASSES: readonly PlanetClass[] = ['terran', 'rocky', 'ocean', 'ice', 'gas'];
export const PLANET_CLASS_WEIGHTS: readonly number[] = [4, 4, 2, 3, 3];

/** Per-class generation parameters. Gas giants have an atmosphere but are never landable. */
export interface PlanetClassProfile {
  radiusKm: readonly [min: number, max: number];
  atmosphereChance: number;
  landableChance: number;
}

export const PLANET_PROFILES: Readonly<Record<PlanetClass, PlanetClassProfile>> = {
  terran: { radiusKm: [3000, 8000], atmosphereChance: 1, landableChance: 0.95 },
  rocky: { radiusKm: [2000, 6500], atmosphereChance: 0.5, landableChance: 0.9 },
  ocean: { radiusKm: [3500, 8000], atmosphereChance: 1, landableChance: 0.7 },
  ice: { radiusKm: [2000, 6000], atmosphereChance: 0.4, landableChance: 0.8 },
  gas: { radiusKm: [20000, 60000], atmosphereChance: 1, landableChance: 0 },
};

export const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI'] as const;
