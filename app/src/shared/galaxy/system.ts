/**
 * Seeded star-system generation (planets, docks, deposit fields, AI roster).
 *
 * Pure and deterministic: generateSystem(seed, starId) returns the exact same
 * SystemGen for the same arguments, in Node and in the browser. The system's
 * sub-seed is hash2(seedFromString(seed), seedFromString(starId)); each planet
 * j derives its own sub-seed hash2(systemSubSeed, j), so planets are
 * independent of generation order and planet ids are stable keys for TASK-5.
 * Planet order is fixed by orbital-slot index, never by runtime values.
 */

import { Rng, seedFromString, hash2 } from '../random.js';
import {
  NAME_PREFIXES,
  NAME_ROOTS,
  PLANET_ATMOSPHERE_CHANCE,
  PLANET_CLASS_WEIGHTS,
  PLANET_LANDABLE_CHANCE,
  RESOURCE_TYPES,
  SHIP_CLASS_IDS,
} from './config.js';
import { generateStars, makeStarName, pickSpectralClass } from './stars.js';
import type { Planet, PlanetClass, ShipClassId, SystemGen } from './types.js';

/** 16-hex-char id from a sub-seed (stable key, same format as star ids). */
function hexId(subSeed: bigint): string {
  return subSeed.toString(16).padStart(16, '0');
}

/** The (seed, starId) sub-seed every system-level value derives from. */
function systemSubSeed(seed: string, starId: string): bigint {
  return hash2(seedFromString(seed), seedFromString(starId));
}

/** Weighted planet-class pick. Weights need not sum to 1. */
function pickPlanetClass(rng: Rng): PlanetClass {
  const total = PLANET_CLASS_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.nextF64() * total;
  for (const [cls, w] of PLANET_CLASS_WEIGHTS) {
    roll -= w;
    if (roll < 0) return cls;
  }
  return PLANET_CLASS_WEIGHTS[PLANET_CLASS_WEIGHTS.length - 1][0];
}

/** prefix + root, each drawn from a seeded word list (shorter than star names). */
function makePlanetName(rng: Rng): string {
  return rng.pick(NAME_PREFIXES) + rng.pick(NAME_ROOTS);
}

/**
 * Pick `count` unique resource types without replacement, in draw order.
 * Redraws on collision keep the output deterministic.
 */
function pickResourceTypes(rng: Rng, count: number): string[] {
  const picked = new Set<number>();
  const out: string[] = [];
  let guard = 0;
  while (out.length < count && guard < 64) {
    const idx = rng.nextInt(RESOURCE_TYPES.length);
    guard += 1;
    if (picked.has(idx)) continue;
    picked.add(idx);
    out.push(RESOURCE_TYPES[idx]);
  }
  return out;
}

/**
 * Generate one planet of a system from the (seed, starId, index) triple.
 * Exposed so callers can regenerate a single planet (and tests can verify
 * per-planet sub-seed independence from generation order).
 *
 * Draw order is fixed and documented: class, radius, atmosphere, landable,
 * docks, resource types, AI roster, name.
 */
export function generatePlanet(seed: string, starId: string, planetIndex: number): Planet {
  const subSeed = hash2(systemSubSeed(seed, starId), BigInt(planetIndex));
  const rng = new Rng(subSeed);

  const cls = pickPlanetClass(rng);
  // Gas giants 20k-60k km; everything else 2k-8k km.
  const radiusKm = cls === 'gas' ? rng.nextRange(20000, 60000) : rng.nextRange(2000, 8000);
  const hasAtmosphere = rng.nextF64() < PLANET_ATMOSPHERE_CHANCE[cls];
  // Gas giants are never landable; others roll per-class landability.
  const landable = cls !== 'gas' && rng.nextF64() < PLANET_LANDABLE_CHANCE[cls];
  const dockCount = landable ? 1 + rng.nextInt(3) : 0;
  const resourceTypes = pickResourceTypes(rng, 1 + rng.nextInt(3)); // 1..3
  const rosterCount = 2 + rng.nextInt(4); // 2..5
  const classes: ShipClassId[] = Array.from({ length: rosterCount }, () =>
    rng.pick(SHIP_CLASS_IDS),
  );

  return {
    id: hexId(subSeed),
    name: makePlanetName(rng),
    class: cls,
    radiusKm,
    hasAtmosphere,
    landable,
    dockCount,
    resourceTypes,
    aiRoster: { count: rosterCount, classes },
  };
}

/**
 * Re-draw a planet name deterministically when it collides with a sibling.
 * The name is the last draw of the planet Rng, so re-drawing it never shifts
 * any other planet field.
 */
function redrawName(seed: string, starId: string, planetIndex: number, attempt: number): string {
  const subSeed = hash2(hash2(systemSubSeed(seed, starId), BigInt(planetIndex)), BigInt(attempt));
  return makePlanetName(new Rng(subSeed));
}

/**
 * Deterministically generate a full star system from a galaxy seed and the
 * 16-hex star id.
 *
 * systemId = hex of the (seed, starId) sub-seed; the star's name/class come
 * from that sub-seed's Rng; planets fill orbital slots 0..n-1 with their own
 * sub-seeds; planet names are unique within the system via deterministic
 * re-draws.
 */
export function generateSystem(seed: string, starId: string): SystemGen {
  const subSeed = systemSubSeed(seed, starId);
  const starRng = new Rng(subSeed);
  const starName = makeStarName(starRng);
  const starClass = pickSpectralClass(starRng);

  const planetCount = 2 + starRng.nextInt(5); // 2..6
  const planets: Planet[] = [];
  const usedNames = new Set<string>();
  for (let j = 0; j < planetCount; j++) {
    let planet = generatePlanet(seed, starId, j);
    let attempt = 0;
    while (usedNames.has(planet.name) && attempt < 64) {
      planet = { ...planet, name: redrawName(seed, starId, j, ++attempt) };
    }
    usedNames.add(planet.name);
    planets.push(planet);
  }

  return {
    systemId: hexId(subSeed),
    name: `${starName} system`,
    star: { class: starClass, name: starName },
    planets,
  };
}

/** Memoized per (seed, systemId): a warp arrival derives the world once. */
const systemByIdCache = new Map<string, SystemGen | undefined>();

/**
 * Look up the generated system for a system id (the client world swap,
 * TASK-8, receives systemId — not a starId — from the server). Scans the
 * seeded stars with the same (seed, starId) sub-seed scheme as
 * generateSystem; unknown ids return undefined. Memoized: re-warping into
 * the same system is one map hit.
 */
export function systemForId(seed: string, systemId: string): SystemGen | undefined {
  const key = `${seed}|${systemId}`;
  if (systemByIdCache.has(key)) return systemByIdCache.get(key);
  for (const star of generateStars(seed)) {
    const system = generateSystem(seed, star.id);
    if (system.systemId === systemId) {
      systemByIdCache.set(key, system);
      return system;
    }
  }
  systemByIdCache.set(key, undefined);
  return undefined;
}
