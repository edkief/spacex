import { describe, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystem } from '@shared/galaxy/system.ts';
import { expectMatchesFixture } from '@tests/support/fixtures.ts';

const SEED = 'drift-dev-seed-001';

describe.each([0, 1])('system of star #%i golden fixture', (index) => {
  it('matches the committed fixture', () => {
    const star = generateStars(SEED)[index]!;
    expectMatchesFixture(`system-star-${index}.json`, {
      seed: SEED,
      starId: star.id,
      system: generateSystem(SEED, star.id),
    });
  });
});
