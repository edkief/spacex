import { describe, expect, it } from 'vitest';
import { homeDockPosition } from './dock';

const SEED = 'drift-dev-seed-001';
const A = 'a'.repeat(16);
const B = 'b'.repeat(16);

describe('homeDockPosition (TASK-20)', () => {
  it('is deterministic for the same (seed, systemId)', () => {
    expect(homeDockPosition(SEED, A)).toEqual(homeDockPosition(SEED, A));
  });

  it('yields integer coordinates in [-100, 100] on the docking plane', () => {
    for (const systemId of [A, B, 'c'.repeat(16)]) {
      const { x, y, z } = homeDockPosition(SEED, systemId);
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(z)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(-100);
      expect(x).toBeLessThanOrEqual(100);
      expect(z).toBeGreaterThanOrEqual(-100);
      expect(z).toBeLessThanOrEqual(100);
      expect(y).toBe(0);
    }
  });

  it('varies across systems', () => {
    const pa = homeDockPosition(SEED, A);
    const pb = homeDockPosition(SEED, B);
    expect(pa).not.toEqual(pb);
  });

  it('varies across galaxy seeds', () => {
    expect(homeDockPosition(SEED, A)).not.toEqual(homeDockPosition('other-seed', A));
  });
});
