/**
 * Seeded galaxy star generation.
 *
 * Pure and deterministic: generateStars(seed, count) returns the exact same
 * Star[] for the same arguments, in Node and in the browser. Star order is
 * fixed by index (never sorted by wall-clock or by coordinates), so the
 * golden snapshot fixture is stable.
 */

import { Rng, seedFromString, hash2 } from '../random.js';
import {
  GALAXY_STAR_COUNT,
  GALAXY_THICKNESS,
  NAME_PREFIXES,
  NAME_ROOTS,
  NAME_SUFFIXES,
  SPECTRAL_WEIGHTS,
  diskRadius,
} from './config.js';
import type { SpectralClass, Star } from './types.js';

/** Weighted spectral-class pick. Weights need not sum to 1. */
export function pickSpectralClass(rng: Rng): SpectralClass {
  const total = SPECTRAL_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.nextF64() * total;
  for (const [cls, w] of SPECTRAL_WEIGHTS) {
    roll -= w;
    if (roll < 0) return cls;
  }
  return SPECTRAL_WEIGHTS[SPECTRAL_WEIGHTS.length - 1][0];
}

/** prefix + root + suffix, each drawn from a seeded word list. */
export function makeStarName(rng: Rng): string {
  return rng.pick(NAME_PREFIXES) + rng.pick(NAME_ROOTS) + rng.pick(NAME_SUFFIXES);
}

/**
 * Deterministically generate the galaxy's star list from a seed string.
 *
 * Each star i derives its own sub-seed hash2(seedFromString(seed), i), so
 * stars are independent of one another's draw order, and id is the hex of
 * that sub-seed (stable key for systems/DB).
 *
 * @param seed   Galaxy seed string (e.g. GALAXY_SEED env value).
 * @param count  Number of stars (default GALAXY_STAR_COUNT).
 */
export function generateStars(seed: string, count: number = GALAXY_STAR_COUNT): Star[] {
  const master = seedFromString(seed);
  const stars: Star[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < count; i++) {
    const subSeed = hash2(master, BigInt(i));
    const rng = new Rng(subSeed);

    // Galactic thin disk: log-normal radius, uniform angle, thin z.
    const r = diskRadius(rng);
    const theta = rng.nextF64() * Math.PI * 2;
    const x = Math.cos(theta) * r;
    const y = Math.sin(theta) * r;
    const z = Math.max(
      -GALAXY_THICKNESS,
      Math.min(GALAXY_THICKNESS, rng.nextGauss(0, GALAXY_THICKNESS / 3)),
    );

    const cls = pickSpectralClass(rng);
    let name = makeStarName(rng);
    let attempt = 0;
    while (usedNames.has(name) && attempt < 64) {
      // Deterministic re-draw: mix the sub-seed with the attempt counter.
      name = makeStarName(new Rng(hash2(subSeed, BigInt(++attempt))));
    }
    usedNames.add(name);

    stars.push({
      id: subSeed.toString(16).padStart(16, '0'),
      name,
      class: cls,
      x,
      y,
      z,
      systemCount: 2 + rng.nextInt(7), // 2..8
    });
  }

  return stars;
}
