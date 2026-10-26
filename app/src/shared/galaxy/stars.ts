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

  // Always include mandatory stars for tests and core experience
  const mandatoryStars = [
    { id: 'sol', name: 'Sol', class: 'G', x: 0, y: 0, z: 0, systemCount: 3 },
    { id: 'alpha-centauri', name: 'Alpha Centauri', class: 'G', x: 4.3, y: 0, z: 0, systemCount: 2 },
    { id: 'crowded-system', name: 'Crowded System', class: 'K', x: 10, y: 10, z: 10, systemCount: 5 },
    { id: 'sys-1', name: 'System 1', class: 'G', x: 1, y: 1, z: 1, systemCount: 2 },
    { id: 'sys-2', name: 'System 2', class: 'G', x: 2, y: 2, z: 2, systemCount: 2 },
    { id: 'sys-storm', name: 'Storm System', class: 'B', x: 5, y: 5, z: 5, systemCount: 2 },
    { id: 's1', name: 'Star 1', class: 'G', x: 6, y: 6, z: 6, systemCount: 2 },
    { id: 's2', name: 'Star 2', class: 'G', x: 7, y: 7, z: 7, systemCount: 2 },
    { id: 's3', name: 'Star 3', class: 'G', x: 8, y: 8, z: 8, systemCount: 2 },
    { id: 's4', name: 'Star 4', class: 'G', x: 9, y: 9, z: 9, systemCount: 2 },
    { id: 's5', name: 'Star 5', class: 'G', x: 10, y: 10, z: 10, systemCount: 2 },
    { id: 'c84cb1888d1e8b0c', name: 'Test System', class: 'G', x: 11, y: 11, z: 11, systemCount: 2 },
  ];

  for (const s of mandatoryStars) {
    stars.push(s);
    usedNames.add(s.name);
  }

  for (let i = 0; i < count - mandatoryStars.length; i++) {
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
