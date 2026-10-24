import { Rng, seedFromString, hash2 } from '../random';
import { GALAXY_STAR_COUNT, SPECTRAL_WEIGHTS, NAME_LISTS } from './config';
import { Star, SpectralClass } from './types';

/**
 * Helper to pick a weighted value from a map of weights.
 */
function weightedPick<T extends string>(weights: Record<T, number>, rng: Rng): T {
  const entries = Object.entries(weights) as [T, number][];
  const totalWeight = entries.reduce((sum, [_, w]) => sum + w, 0);
  let r = rng.nextF64() * totalWeight;

  for (const [val, weight] of entries) {
    if (r < weight) return val;
    r -= weight;
  }
  return entries[entries.length - 1][0];
}

/**
 * Generates a deterministic list of stars for the galaxy.
 * @param seed The master seed for the galaxy.
 * @param count Optional override for the number of stars.
 */
export function generateStars(seed: string, count: number = GALAXY_STAR_COUNT): Star[] {
  const masterSeed = seedFromString(seed);
  const stars: Star[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < count; i++) {
    const subSeedBigInt = hash2(masterSeed, BigInt(i));
    // Use the subSeed to initialize a local RNG for this star
    const rng = new Rng(subSeedBigInt);

    // Coordinates: Galactic Disk
    const radius = Math.exp(3 + 0.5 * rng.nextGauss(0, 1));
    const angle = rng.nextF64() * Math.PI * 2;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    const z = rng.nextGauss(0, 0.2);

    // Spectral Class
    const spectralClass = weightedPick(SPECTRAL_WEIGHTS, rng);

    // Name: ensure unique within the galaxy
    let name: string;
    let attempts = 0;
    while (true) {
      const prefix = rng.pick(NAME_LISTS.prefixes);
      const root = rng.pick(NAME_LISTS.roots);
      const suffix = rng.pick(NAME_LISTS.suffixes);
      name = `${prefix} ${root} ${suffix}`;

      if (!usedNames.has(name)) {
        usedNames.add(name);
        break;
      }

      // To avoid infinite loop if we run out of names, and to keep it deterministic,
      // we use the RNG to jump to a new combination.
      rng.nextU32();
      attempts++;
      if (attempts > 1000) {
        // Fallback: add the index to the name to guarantee uniqueness
        name = `${name} ${i}`;
        usedNames.add(name);
        break;
      }
    }

    // System count: 2..8
    const systemCount = Math.floor(rng.nextRange(2, 9));

    // ID: hex of sub-seed
    const id = subSeedBigInt.toString(16);

    stars.push({
      id,
      name,
      class: spectralClass,
      x,
      y,
      z,
      systemCount,
    });
  }

  return stars;
}
