import { describe, it } from 'vitest';
import { generateSurfaceChunk } from '@shared/galaxy/surface.ts';
import { firstPlanet } from '@tests/support/galaxy.ts';
import { chunkFixtureBody } from '@tests/support/snapshotCases.ts';
import { expectMatchesFixture } from '@tests/support/fixtures.ts';

const SEED = 'drift-dev-seed-001';

describe.each([
  [0, 0],
  [1, 0],
  [0, 1],
])('surface chunk (%i,%i) golden fixture', (cx, cz) => {
  it('matches the committed fixture', () => {
    const { planet } = firstPlanet(SEED, (p) => p.landable);
    const chunk = generateSurfaceChunk(SEED, planet, cx, cz);
    expectMatchesFixture(`surface-${cx}-${cz}.json`, {
      seed: SEED,
      planetId: planet.id,
      chunk: chunkFixtureBody(chunk),
    });
  });
});
