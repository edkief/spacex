import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@shared/canonical.ts';
import { generateStars } from '@shared/galaxy/stars.ts';
import { sha256Hex } from '@tests/support/checksum.ts';
import { expectMatchesFixture, readFixture } from '@tests/support/fixtures.ts';

// Runs under both vitest projects. jsdom shares V8 with node, so this proves import-cleanliness
// in a browser-like environment, not cross-engine equality (that needs the browser e2e, TASK-71).
const SEED = 'drift-dev-seed-001';

describe('star chart golden fixture', () => {
  const fixture = JSON.parse(readFixture('stars-dev-seed.json')) as {
    count: number;
    checksum: string;
    stars: unknown[];
  };

  it('has the committed length and checksum', () => {
    const stars = generateStars(SEED);
    expect(stars).toHaveLength(fixture.count);
    expect(sha256Hex(canonicalJson(stars))).toBe(fixture.checksum);
  });

  it('matches the committed fixture exactly', () => {
    expectMatchesFixture('stars-dev-seed.json', {
      seed: SEED,
      count: fixture.count,
      checksum: fixture.checksum,
      stars: generateStars(SEED),
    });
  });

  it('keeps the first 25 stars stable', () => {
    expect(generateStars(SEED).slice(0, 25)).toEqual(fixture.stars.slice(0, 25));
  });
});
