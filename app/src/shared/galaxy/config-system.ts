/**
 * Configuration for deterministic star system generation.
 */

export const PLANET_COUNT_RANGE = { min: 2, max: 6 };

export const PLANET_CLASSES = [
  { class: 'terran', weight: 10 },
  { class: 'rocky', weight: 30 },
  { class: 'ice', weight: 20 },
  { class: 'ocean', weight: 20 },
  { class: 'gas', weight: 20 },
] as const;

export const RADIUS_RANGES = {
  gas: { min: 20000, max: 60000 },
  standard: { min: 2000, max: 8000 },
};

export const ATMOSPHERE_PROBABILITIES = {
  terran: 1.0,
  rocky: 0.2,
  ice: 0.3,
  ocean: 0.9,
  gas: 1.0,
};

export const ATMOSPHERE_RANGES = {
  gas: {
    height: { min: 5000, max: 20000 },
    density: { min: 0.5, max: 2.0 },
  },
  standard: {
    height: { min: 50, max: 500 },
    density: { min: 0.1, max: 1.0 },
  },
};

export const RESOURCE_POOL = [
  'iron',
  'copper',
  'silicon',
  'rare-earths',
  'water',
  'gas-compounds',
] as const;
export const RESOURCE_COUNT_RANGE = { min: 1, max: 3 };

export const AI_ROSTER_COUNT_RANGE = { min: 2, max: 5 };
export const SHIP_CLASSES = ['scout', 'freighter', 'interceptor'] as const;

export const PLANET_NAME_PREFIXES = [
  'Nova',
  'Aurelia',
  'Krios',
  'Xylos',
  'Zephyr',
  'Thalassa',
  'Pyros',
  'Gaea',
  'Hestia',
  'Erebos',
];
export const PLANET_NAME_SUFFIXES = [
  'Prime',
  'Minor',
  'Major',
  'Alpha',
  'Beta',
  'Gamma',
  'Delta',
  'Omega',
  'IV',
  'IX',
];
