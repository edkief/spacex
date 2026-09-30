/**
 * TASK-71: property-style determinism tests.
 *
 * Instead of a single golden snapshot, these tests sweep MANY random
 * inputs — but the test's own randomness is drawn from a FIXED meta-seed,
 * so every run exercises the exact same (seed, star, planet, chunk) sample
 * and any failure is trivially reproducible.
 *
 * - generateSystem: 10 random seeds × 10 stars each, deep-equal across two
 *   independent generator invocations.
 * - Surface chunks: 200 random (planet, chunk) pairs produce identical
 *   nodeId sets and node positions across two invocations (plus full-chunk
 *   deep equality as a superset).
 */

import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from '../random.js';
import { generateStars } from './stars.js';
import { generateSystem } from './system.js';
import { generateSurfaceChunk } from './surface.js';
import type { Planet } from './types.js';

/** Fixed meta-seed: the test's "randomness" is itself deterministic. */
const META = new Rng(seedFromString('TASK-71-PROPERTIES-META'));

/** Deterministic pseudo-random seed string. */
function randomSeed(label: string, n: number): string {
  return `${label}-${n}-${META.nextU32().toString(16).padStart(8, '0')}`;
}

/**
 * Walk two generated structures in lockstep and return the field path of
 * the FIRST divergence (e.g. `$.planets[2].dockCount`), or null if equal.
 * Strict (Object.is-grade) comparison: determinism means bitwise-identical
 * outputs, so any value difference is a real divergence.
 */
function firstDivergence(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== 'object' || tb !== 'object' || a === null || b === null) {
    return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const arrA = a as unknown[];
  const arrB = b as unknown[];
  if (Array.isArray(a)) {
    if (arrA.length !== arrB.length) {
      return `${path}: length ${arrA.length} vs ${arrB.length}`;
    }
    for (let i = 0; i < arrA.length; i++) {
      const d = firstDivergence(arrA[i], arrB[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).sort();
  const keysB = Object.keys(objB).sort();
  if (keysA.join(',') !== keysB.join(',')) {
    return `${path}: keys [${keysA}] vs [${keysB}]`;
  }
  for (const key of keysA) {
    const d = firstDivergence(objA[key], objB[key], `${path}.${key}`);
    if (d !== null) return d;
  }
  return null;
}

function expectIdentical(a: unknown, b: unknown, what: string): void {
  const divergence = firstDivergence(a, b);
  expect(divergence, `${what} diverged at ${divergence ?? 'first comparison'}`).toBeNull();
}

describe('TASK-71 determinism properties', () => {
  it('generateSystem is stable: 10 seeds x 10 stars deep-equal across two invocations', () => {
    for (let s = 0; s < 10; s++) {
      const seed = randomSeed('seed', s);
      const starsA = generateStars(seed, 10);
      const starsB = generateStars(seed, 10);
      expectIdentical(starsA, starsB, `seed '${seed}' star chart`);
      for (let i = 0; i < starsA.length; i++) {
        const sysA = generateSystem(seed, starsA[i].id);
        const sysB = generateSystem(seed, starsB[i].id);
        expectIdentical(sysA, sysB, `seed '${seed}' star[${i}] '${starsA[i].name}'`);
      }
    }
  });

  it('200 random (planet, chunk) pairs: identical nodeId sets and node positions', () => {
    // Pool: 10 seeds x 10 stars, every planet of every generated system.
    const pool: Array<{ seed: string; planet: Planet }> = [];
    for (let s = 0; s < 10; s++) {
      const seed = randomSeed('pool', s);
      const stars = generateStars(seed, 10);
      for (const star of stars) {
        const system = generateSystem(seed, star.id);
        for (const planet of system.planets) pool.push({ seed, planet });
      }
    }
    expect(pool.length).toBeGreaterThan(0);

    for (let p = 0; p < 200; p++) {
      const { seed, planet } = pool[META.nextInt(pool.length)];
      const cx = META.nextInt(64);
      const cz = META.nextInt(64);
      const a = generateSurfaceChunk(seed, planet, cx, cz);
      const b = generateSurfaceChunk(seed, planet, cx, cz);
      const label = `pair ${p} (seed '${seed}' planet ${planet.id} chunk ${cx},${cz})`;

      // AC fields: nodeId set + node positions.
      const idsA = a.resourceNodes.map((n) => n.nodeId).sort();
      const idsB = b.resourceNodes.map((n) => n.nodeId).sort();
      expectIdentical(idsA, idsB, `${label} nodeId set`);
      expectIdentical(
        a.resourceNodes.map((n) => [n.x, n.z]),
        b.resourceNodes.map((n) => [n.x, n.z]),
        `${label} node positions`,
      );
      // Superset: the whole chunk (heightmap, biome, pads) must match too.
      expectIdentical(a, b, `${label} full chunk`);
    }
  });
});
