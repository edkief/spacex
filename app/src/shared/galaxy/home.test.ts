import { describe, expect, it } from 'vitest';

import { homeSystemIdForPlayer } from './home';
import { generateStars } from './stars';
import { generateSystem } from './system';
import { GALAXY_STAR_COUNT } from './config';

const SEED = 'drift-dev-seed-001';

/**
 * Build an id whose first 15 hex digits (after dash removal) are exactly
 * `hex`: the uuid dash layout puts dashes after positions 8 and 13, so the
 * first 15 de-dashed chars are group-1 (8) + the first 7 of group-2.
 */
function playerIdWithPrefix(hex: string): string {
  const pad = hex.padStart(15, '0').slice(-15);
  return `${pad.slice(0, 8)}-${pad.slice(8, 15)}-0000-0000-000000000000`;
}

describe('homeSystemIdForPlayer', () => {
  it('always yields a 16-hex system id', () => {
    for (const playerId of [
      '00000000-0000-4000-8000-000000000000',
      '12345678-9abc-4def-8123-456789abcdef',
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    ]) {
      expect(homeSystemIdForPlayer(SEED, playerId)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('derives exactly the system that generateSystem builds for the same star', () => {
    const stars = generateStars(SEED);
    for (const starIndex of [0, 1, 123, GALAXY_STAR_COUNT - 1]) {
      const starId = stars[starIndex].id;
      const built = generateSystem(SEED, starId);
      // A player id whose 15-hex prefix equals the star index maps to that star.
      const playerId = playerIdWithPrefix(starIndex.toString(16));
      expect(homeSystemIdForPlayer(SEED, playerId)).toBe(built.systemId);
    }
  });

  it('is deterministic per player id and differs between players', () => {
    const a = homeSystemIdForPlayer(SEED, 'abcd1234-dead-4be0-8f00-111122223333');
    expect(homeSystemIdForPlayer(SEED, 'abcd1234-dead-4be0-8f00-111122223333')).toBe(a);
    // Only the first 15 de-dashed hex digits select the star, so change one of them.
    expect(homeSystemIdForPlayer(SEED, 'abce1234-dead-4be0-8f00-111122223333')).not.toBe(a);
  });

  it('changes with the galaxy seed', () => {
    const id = homeSystemIdForPlayer(SEED, 'abcd1234-dead-4be0-8f00-111122223333');
    expect(homeSystemIdForPlayer('other-seed', 'abcd1234-dead-4be0-8f00-111122223333')).not.toBe(
      id,
    );
  });

  it('spreads players across systems (no single-system collapse)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(homeSystemIdForPlayer(SEED, playerIdWithPrefix(i.toString(16))));
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});
