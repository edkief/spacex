import { SHIP_CLASS_IDS } from '../ships/ids.ts';
import { Rng, hash2, hex64, seedFromString } from '../random.ts';
import { generateStars } from './stars.ts';
import {
  MAX_AI_COUNT,
  MAX_DOCKS,
  MAX_PLANETS,
  MAX_RESOURCE_TYPES,
  MIN_AI_COUNT,
  MIN_PLANETS,
  PLANET_CLASSES,
  PLANET_CLASS_WEIGHTS,
  PLANET_PROFILES,
  RESOURCE_TYPES,
  ROMAN_NUMERALS,
} from './systemConfig.ts';
import type { AiRoster, Planet, Star, SystemGen } from './types.ts';

const STAR_ID_PATTERN = /^[0-9a-f]{16}$/;

/** Picks 1..MAX distinct resource types by partial Fisher-Yates, in draw order. */
function pickResources(rng: Rng): string[] {
  const pool: string[] = [...RESOURCE_TYPES];
  const count = 1 + rng.nextInt(MAX_RESOURCE_TYPES);
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const index = rng.nextInt(pool.length);
    picked.push(pool[index] as string);
    pool.splice(index, 1);
  }
  return picked;
}

/** Draws the rogue-AI patrol: MIN..MAX ships, each of a seeded ship class. */
function pickRoster(rng: Rng): AiRoster {
  const count = MIN_AI_COUNT + rng.nextInt(MAX_AI_COUNT - MIN_AI_COUNT + 1);
  const classes = Array.from({ length: count }, () => rng.pick(SHIP_CLASS_IDS));
  return { count, classes };
}

/** Generates planet `index` from its own sub-seed so planets never disturb each other. */
function generatePlanet(systemSeed: bigint, starName: string, index: number): Planet {
  const planetSeed = hash2(systemSeed, BigInt(index));
  const rng = new Rng(planetSeed);
  const planetClass = rng.pickWeighted(PLANET_CLASSES, PLANET_CLASS_WEIGHTS);
  const profile = PLANET_PROFILES[planetClass];
  const radiusKm = Math.round(rng.nextRange(profile.radiusKm[0], profile.radiusKm[1]));
  const hasAtmosphere = rng.chance(profile.atmosphereChance);
  const landable = planetClass !== 'gas' && rng.chance(profile.landableChance);
  const dockCount = landable ? 1 + rng.nextInt(MAX_DOCKS) : 0;
  return {
    id: hex64(planetSeed),
    name: `${starName} ${ROMAN_NUMERALS[index] ?? String(index + 1)}`,
    class: planetClass,
    radiusKm,
    hasAtmosphere,
    landable,
    dockCount,
    resourceTypes: pickResources(rng),
    aiRoster: pickRoster(rng),
  };
}

/**
 * Generates the system of an already-known star. The system seed is
 * `hash2(masterSeed, starId)`; planets are produced in index order, never by runtime values.
 */
export function generateSystemForStar(seed: string, star: Star): SystemGen {
  if (!STAR_ID_PATTERN.test(star.id)) throw new RangeError(`invalid star id: ${star.id}`);
  const systemSeed = hash2(seedFromString(seed), BigInt(`0x${star.id}`));
  const planetCount = MIN_PLANETS + new Rng(systemSeed).nextInt(MAX_PLANETS - MIN_PLANETS + 1);
  return {
    systemId: hex64(systemSeed),
    name: `${star.name} System`,
    star: { class: star.class, name: star.name },
    planets: Array.from({ length: planetCount }, (_, i) =>
      generatePlanet(systemSeed, star.name, i),
    ),
  };
}

/**
 * Deterministically generates the system for `starId` in the galaxy of `seed`.
 * `starCount` must match the chart size used by the caller (default: the standard chart).
 * @throws RangeError when `starId` is malformed or not part of the chart.
 */
export function generateSystem(seed: string, starId: string, starCount?: number): SystemGen {
  if (!STAR_ID_PATTERN.test(starId)) throw new RangeError(`invalid star id: ${starId}`);
  const star = generateStars(seed, starCount).find((candidate) => candidate.id === starId);
  if (!star) throw new RangeError(`unknown star id for this seed: ${starId}`);
  return generateSystemForStar(seed, star);
}
