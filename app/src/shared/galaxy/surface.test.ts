import { describe, it, expect } from 'vitest';
import { generateSurfaceChunk } from './surface';
import { Planet } from './types';
import { Rng, seedFromString } from '../random';

const MOCK_PLANET: Planet = {
  id: 'p-1',
  name: 'Test Planet',
  class: 'terran',
  radiusKm: 6000,
  hasAtmosphere: true,
  landable: true,
  dockCount: 1,
  resourceTypes: ['iron', 'silicon'],
  aiRoster: {
    count: 2,
    classes: ['scout', 'interceptor'],
  },
};

const DEV_SEED = 'drift-dev-seed-001';

describe('Surface Chunk Generator', () => {
  it('should be deterministic', () => {
    const chunk1 = generateSurfaceChunk(DEV_SEED, MOCK_PLANET, 0, 0);
    const chunk2 = generateSurfaceChunk(DEV_SEED, MOCK_PLANET, 0, 0);
    expect(chunk1).toEqual(chunk2);
  });

  it('should be stable across multiple random chunks', { timeout: 20000 }, () => {
    const iterations = 100;
    const results1: string[] = [];
    const results2: string[] = [];

    // Use a fixed seed for the test's own randomness to ensure reproducible failures
    const testRng = new Rng(seedFromString('test-stability-seed'));

    for (let i = 0; i < iterations; i++) {
      const cx = testRng.nextInt(1000);
      const cz = testRng.nextInt(1000);

      const c1 = generateSurfaceChunk(DEV_SEED, MOCK_PLANET, cx, cz);
      const c2 = generateSurfaceChunk(DEV_SEED, MOCK_PLANET, cx, cz);

      results1.push(JSON.stringify(c1));
      results2.push(JSON.stringify(c2));
    }

    expect(results1).toEqual(results2);
  });

  it('should maintain boundary continuity', () => {
    const chunk00 = generateSurfaceChunk(DEV_SEED, MOCK_PLANET, 0, 0);
    const chunk10 = generateSurfaceChunk(DEV_SEED, MOCK_PLANET, 1, 0);

    // Right edge of (0,0) is x=63. Left edge of (1,0) is x=0.
    // However, heightmap is indexed as z * 64 + x.
    for (let z = 0; z < 64; z++) {
      const h0 = chunk00.heightmap[z * 64 + 63];
      const h1 = chunk10.heightmap[z * 64 + 0];

      // We expect small delta because of smoothstep and fBm
      // Let's check if it's within a reasonable range.
      // Since we use world coordinates for sampling, they should be very close.
      // In a real value noise, the samples at the border are shared.
      expect(Math.abs(h0 - h1)).toBeLessThan(5);
    }
  });

  it('should force a landing pad at chunk (0,0) for landable planets', () => {
    const chunk = generateSurfaceChunk(DEV_SEED, MOCK_PLANET, 0, 0);
    expect(chunk.landingPads.length).toBe(1);
  });

  it('should have a stable golden snapshot for chunk (0,0)', () => {
    const chunk = generateSurfaceChunk(DEV_SEED, MOCK_PLANET, 0, 0);

    // Sample 16 points from heightmap to avoid huge snapshots in this test
    const sampledHeightmap = [];
    for (let i = 0; i < 16; i++) {
      sampledHeightmap.push(chunk.heightmap[i * 4 * 64 + i * 4]);
    }

    console.log('Golden Snapshot - Biome:', chunk.biome);
    console.log('Golden Snapshot - Heightmap:', JSON.stringify(sampledHeightmap));

    expect(chunk.biome).toBe('plains');
    expect(sampledHeightmap).toEqual([
      78, 64, 53, 48, 48, 48, 54, 55, 55, 54, 55, 51, 47, 44, 37, 36,
    ]);
  });
});
