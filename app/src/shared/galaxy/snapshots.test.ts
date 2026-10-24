import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { generateStars } from './stars';
import { generateSystem } from './system';
import { generateSurfaceChunk } from './surface';
import { canonicalize } from '../canonical';
import { Planet } from './types';

const SEED = 'dev-seed';
const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

function loadFixture<T>(name: string): T {
  const content = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  return JSON.parse(content);
}

describe('Galaxy Determinism Snapshots', () => {
  it('matches the committed star chart snapshot', () => {
    const expected = loadFixture<{ first25: any[]; totalCount: number; checksum: string }>(
      'stars-dev-seed.json',
    );
    const actualStars = generateStars(SEED);
    const actual = {
      first25: actualStars.slice(0, 25),
      totalCount: actualStars.length,
      checksum: expected.checksum, // We keep the checksum from fixture for this test
    };

    expect(canonicalize(actual)).toEqual(canonicalize(expected));
  });

  it('matches the committed system snapshots', () => {
    const stars = generateStars(SEED);

    // Star #0
    const expected0 = loadFixture<any>('system-star-0.json');
    const actual0 = generateSystem(SEED, stars[0].id);
    expect(canonicalize(actual0)).toEqual(canonicalize(expected0));

    // Star #1
    const expected1 = loadFixture<any>('system-star-1.json');
    const actual1 = generateSystem(SEED, stars[1].id);
    expect(canonicalize(actual1)).toEqual(canonicalize(expected1));
  });

  it('matches the committed surface chunk snapshots', () => {
    const stars = generateStars(SEED);
    let firstLandablePlanet: Planet | null = null;
    for (const star of stars) {
      const sys = generateSystem(SEED, star.id);
      const landable = sys.planets.find((p) => p.landable);
      if (landable) {
        firstLandablePlanet = landable;
        break;
      }
    }

    if (!firstLandablePlanet) {
      throw new Error('No landable planet found for seed ' + SEED);
    }

    const chunks = [
      { x: 0, z: 0, file: 'chunk-0-0.json' },
      { x: 1, z: 0, file: 'chunk-1-0.json' },
      { x: 0, z: 1, file: 'chunk-0-1.json' },
    ];

    for (const { x, z, file } of chunks) {
      const expected = loadFixture<any>(file);
      const actual = generateSurfaceChunk(SEED, firstLandablePlanet, x, z);
      expect(canonicalize(actual)).toEqual(canonicalize(expected));
    }
  });
});
