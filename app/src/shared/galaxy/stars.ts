import { Rng, hash2, hex64, seedFromString } from '../random.ts';
import {
  GALAXY_INNER_FRACTION,
  GALAXY_RADIUS,
  GALAXY_STAR_COUNT,
  GALAXY_THICKNESS_SD,
  MAX_SYSTEM_COUNT,
  MIN_SYSTEM_COUNT,
  STAR_CLASSES,
  STAR_CLASS_WEIGHTS,
} from './config.ts';
import { buildName } from './names.ts';
import { round3 } from './quantize.ts';
import type { Star } from './types.ts';

const MAX_STARS = 100_000;
const NAME_ATTEMPTS = 64;

/**
 * Samples a unit direction in the plane by rejection-sampling a point in the unit disc and
 * normalising with sqrt (no sin/cos, so it is identical in every JS engine).
 */
function randomDirection(rng: Rng): { dx: number; dy: number } {
  for (;;) {
    const px = rng.nextRange(-1, 1);
    const py = rng.nextRange(-1, 1);
    const squared = px * px + py * py;
    if (squared <= 1 && squared > 1e-9) {
      const length = Math.sqrt(squared);
      return { dx: px / length, dy: py / length };
    }
  }
}

/** Picks a unique name by re-drawing on collision; falls back to a numbered name if unlucky. */
function uniqueName(rng: Rng, taken: ReadonlySet<string>, index: number): string {
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const name = buildName(rng);
    if (!taken.has(name)) return name;
  }
  return `${buildName(rng)}-${index}`;
}

/**
 * Generates one star from its own sub-seed `hash2(master, index)`. The name is drawn last so
 * collision retries never disturb the other fields.
 */
function generateStar(master: bigint, index: number, taken: ReadonlySet<string>): Star {
  const subSeed = hash2(master, BigInt(index));
  const rng = new Rng(subSeed);
  const starClass = rng.pickWeighted(STAR_CLASSES, STAR_CLASS_WEIGHTS);
  const systemCount = MIN_SYSTEM_COUNT + rng.nextInt(MAX_SYSTEM_COUNT - MIN_SYSTEM_COUNT + 1);
  const { dx, dy } = randomDirection(rng);
  // Radius density is centre-heavy with a long tail: u * sqrt(v), kept off the very centre.
  const u = rng.nextF64();
  const v = rng.nextF64();
  const radius =
    GALAXY_RADIUS * (GALAXY_INNER_FRACTION + (1 - GALAXY_INNER_FRACTION) * u * Math.sqrt(v));
  const z = rng.nextGauss(0, GALAXY_THICKNESS_SD);
  return {
    id: hex64(subSeed),
    name: uniqueName(rng, taken, index),
    class: starClass,
    x: round3(dx * radius),
    y: round3(dy * radius),
    z: round3(z),
    systemCount,
  };
}

/**
 * Deterministically generates the galaxy's star list from `seed`. Pure: no clocks, no global
 * state. Star `i` depends only on the seed, `i` and the names of stars `0..i-1`, so the list for
 * a smaller `count` is a prefix of the list for a larger one.
 */
export function generateStars(seed: string, count: number = GALAXY_STAR_COUNT): Star[] {
  if (!Number.isInteger(count) || count < 0 || count > MAX_STARS) {
    throw new RangeError(`star count must be an integer in [0, ${MAX_STARS}], got ${count}`);
  }
  const master = seedFromString(seed);
  const taken = new Set<string>();
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    const star = generateStar(master, i, taken);
    taken.add(star.name);
    stars.push(star);
  }
  return stars;
}
