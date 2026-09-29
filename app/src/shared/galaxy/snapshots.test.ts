/**
 * TASK-6: Galaxy determinism verification (snapshot fixtures).
 *
 * Locks the determinism contract (SC-2): the star chart, the systems of
 * stars #0 and #1, and surface chunks (0,0)/(1,0)/(0,1) of the first
 * landable planet must regenerate byte-stably for the dev seed. This file
 * ONLY compares against the committed fixtures — it never writes them.
 * Regenerate with `npm run snapshot:update` after an approved generator
 * change (see __fixtures__/README.md).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical.js';
import { generateStars } from './stars.js';
import { generateSystem } from './system.js';
import { generateSurfaceChunk } from './surface.js';
import type { PlanetClass, SpectralClass, Star, SurfaceChunk, SystemGen } from './types.js';

const SEED = 'drift-dev-seed-001';
const FIXTURES = path.join(import.meta.dirname, '__fixtures__');

interface FixtureFile {
  seed: string;
  starId?: string;
  planetId?: string;
  chunkX?: number;
  chunkZ?: number;
  value: unknown;
}

function loadFixture(name: string): FixtureFile {
  const raw = readFileSync(path.join(FIXTURES, name), 'utf8');
  return JSON.parse(raw) as FixtureFile;
}

/**
 * First JSON path at which `a` and `b` structurally differ, e.g.
 * "planets.0.class" or "12.x". Returns null when they are equal.
 * Used in failure messages to point at generator drift.
 */
function firstDiffPath(a: unknown, b: unknown, prefix = ''): string | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${prefix}length`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiffPath(a[i], b[i], `${prefix}${i}.`);
      if (d !== null) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const key of [...keys].sort()) {
      const d = firstDiffPath(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${prefix}${key}.`,
      );
      if (d !== null) return d;
    }
    return null;
  }
  return a === b ? null : prefix.replace(/\.$/, '');
}

/**
 * Deep-compare a regenerated value against a committed fixture using
 * canonical serialization (stable key order → platform-stable JSON).
 * On mismatch the failure message names the first diff path.
 */
function expectMatchesFixture(name: string, regenerated: unknown): void {
  const fixture = loadFixture(name);
  expect(fixture.seed, `${name}: fixture seed must be ${SEED}`).toBe(SEED);
  const a = canonicalJson(regenerated);
  const b = canonicalJson(fixture.value);
  const diff = firstDiffPath(regenerated, fixture.value);
  expect(
    a,
    `${name} drifted from committed fixture (first diff at: ${diff ?? 'unknown'}) — ` +
      'if this is an approved generator change, run `npm run snapshot:update` ' +
      'and note the breaking seed behavior in the commit message',
  ).toBe(b);
}

describe('galaxy snapshot fixtures (dev seed)', () => {
  it('full star chart is byte-stable', () => {
    expectMatchesFixture('snapshot-stars-dev-seed.json', generateStars(SEED));
  });

  it('system of star #0 is byte-stable', () => {
    const [star0] = generateStars(SEED);
    expectMatchesFixture('snapshot-system-star0.json', generateSystem(SEED, star0.id));
  });

  it('system of star #1 is byte-stable', () => {
    const [, star1] = generateStars(SEED);
    expectMatchesFixture('snapshot-system-star1.json', generateSystem(SEED, star1.id));
  });

  it.each([
    ['(0,0)', 'snapshot-chunk-0-0.json', 0, 0],
    ['(1,0)', 'snapshot-chunk-1-0.json', 1, 0],
    ['(0,1)', 'snapshot-chunk-0-1.json', 0, 1],
  ] as const)(
    'surface chunk %s of the first landable planet is byte-stable',
    (label, name, cx, cz) => {
      const fixture = loadFixture(name);
      const system = generateSystem(SEED, fixture.starId ?? '');
      const planet = system.planets.find((p) => p.landable);
      expect(planet, 'star #0 must have a landable planet').toBeDefined();
      expectMatchesFixture(name, generateSurfaceChunk(SEED, planet!, cx, cz));
    },
  );
});

describe('snapshot comparison detects generator mutations', () => {
  it('a flipped spectral class in the star chart is caught with a diff path', () => {
    const fixture = loadFixture('snapshot-stars-dev-seed.json') as { value: Star[] };
    const mutated = structuredClone(fixture.value);
    const flipped: SpectralClass = mutated[0].class === 'K' ? 'O' : 'K';
    mutated[0].class = flipped;
    expect(canonicalJson(mutated)).not.toBe(canonicalJson(fixture.value));
    expect(firstDiffPath(mutated, fixture.value)).toBe('0.class');
  });

  it('a flipped planet class weight (regenerated with a changed weight table) is caught', () => {
    // Mirrors the manual mutation check: altering PLANET_CLASS_WEIGHTS in
    // config.ts shifts the weighted pick and must break the system fixture.
    const fixture = loadFixture('snapshot-system-star0.json') as {
      starId: string;
      value: SystemGen;
    };
    const system = generateSystem(SEED, fixture.starId);
    expectMatchesFixture('snapshot-system-star0.json', system); // unmutated still matches
    const mutated = structuredClone(system);
    const otherClass: PlanetClass = mutated.planets[0].class === 'gas' ? 'terran' : 'gas';
    mutated.planets[0].class = otherClass;
    expect(canonicalJson(mutated)).not.toBe(canonicalJson(system));
    expect(firstDiffPath(mutated, system)).toBe('planets.0.class');
  });

  it('a changed heightmap sample in a surface chunk is caught with a diff path', () => {
    const fixture = loadFixture('snapshot-chunk-0-0.json') as { value: SurfaceChunk };
    const mutated = structuredClone(fixture.value);
    mutated.heightmap[0] += 1;
    expect(firstDiffPath(mutated, fixture.value)).toBe('heightmap.0');
  });
});
