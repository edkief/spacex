import { describe, it, expect } from 'vitest';
import { Rng, seedFromString } from '../random';
import { generateSystem } from './system';
import { generateSurfaceChunk } from './surface';
import { generateStars } from './stars';

/**
 * Deeply compares two objects and returns the path to the first divergence.
 * Returns null if they are identical.
 */
function getFieldPath(obj1: any, obj2: any, path: string = ''): string | null {
  if (obj1 === obj2) return null;
  if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null) {
    return path || 'root';
  }
  
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  
  if (keys1.length !== keys2.length) {
    return path || 'root';
  }

  for (const key of keys1) {
    const currentPath = path ? `${path}.${key}` : key;
    const divergence = getFieldPath(obj1[key], obj2[key], currentPath);
    if (divergence) return divergence;
  }
  
  return null;
}

function randomString(rng: Rng, length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let res = '';
  for (let i = 0; i < length; i++) {
    res += chars[rng.nextInt(chars.length)];
  }
  return res;
}

describe('Galaxy Determinism Properties', () => {
  const META_SEED_STR = 'determinism-test-meta-seed';
  const metaRng = new Rng(seedFromString(META_SEED_STR));

  it('should be stable across two independent generator invocations for systems', () => {
    const seeds: string[] = [];
    for (let i = 0; i < 10; i++) {
      seeds.push(randomString(metaRng, 16));
    }

    for (const seed of seeds) {
      const stars = generateStars(seed);
      const starIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const star = stars[metaRng.nextInt(stars.length)];
        starIds.push(star.id);
      }

      for (const starId of starIds) {
        const system1 = generateSystem(seed, starId);
        const system2 = generateSystem(seed, starId);
        
        const divergence = getFieldPath(system1, system2);
        expect(divergence, `System diverged at ${divergence} for seed ${seed}, star ${starId}`).toBeNull();
      }
    }
  });

  it('should be stable across two independent generator invocations for surface chunks', () => {
    const seeds: string[] = [];
    for (let i = 0; i < 10; i++) {
      seeds.push(randomString(metaRng, 16));
    }

    const pairs: { seed: string, planet: any, cx: number, cz: number }[] = [];
    for (let i = 0; i < 200; i++) {
      const seed = seeds[metaRng.nextInt(seeds.length)];
      const stars = generateStars(seed);
      const star = stars[metaRng.nextInt(stars.length)];
      const system = generateSystem(seed, star.id);
      const planet = system.planets[metaRng.nextInt(system.planets.length)];
      const cx = metaRng.nextInt(1000);
      const cz = metaRng.nextInt(1000);
      pairs.push({ seed, planet, cx, cz });
    }

    for (const { seed, planet, cx, cz } of pairs) {
      const chunk1 = generateSurfaceChunk(seed, planet, cx, cz);
      const chunk2 = generateSurfaceChunk(seed, planet, cx, cz);

      const divergence = getFieldPath(chunk1, chunk2);
      expect(divergence, `Chunk diverged at ${divergence} for seed ${seed}, planet ${planet.id}, chunk ${cx},${cz}`).toBeNull();
    }
  }, 30000);
});
