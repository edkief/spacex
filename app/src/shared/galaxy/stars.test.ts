import { describe, expect, it } from 'vitest';
import {
  GALAXY_RADIUS,
  GALAXY_STAR_COUNT,
  GALAXY_THICKNESS_SD,
  MAX_SYSTEM_COUNT,
  MIN_SYSTEM_COUNT,
} from '@shared/galaxy/config.ts';
import { NAME_PREFIXES, NAME_ROOTS, NAME_SUFFIXES } from '@shared/galaxy/names.ts';
import { generateStars } from '@shared/galaxy/stars.ts';

const SEEDS = ['drift-dev-seed-001', 'alpha', 'beta', 'gamma', 'δ-unicode-seed'];

describe('generateStars', () => {
  it('defaults to 200 stars and honours a custom count', () => {
    expect(generateStars('x')).toHaveLength(GALAXY_STAR_COUNT);
    expect(generateStars('x', 7)).toHaveLength(7);
    expect(generateStars('x', 0)).toEqual([]);
  });

  it('rejects invalid counts', () => {
    for (const bad of [-1, 1.5, Number.NaN, 100_001]) {
      expect(() => generateStars('x', bad)).toThrow(RangeError);
    }
  });

  it('has word lists of at least 40 entries', () => {
    for (const list of [NAME_PREFIXES, NAME_ROOTS, NAME_SUFFIXES]) {
      expect(list.length).toBeGreaterThanOrEqual(40);
    }
  });

  it('gives a smaller chart as a prefix of a larger one', () => {
    expect(generateStars('prefix', 30)).toEqual(generateStars('prefix', 80).slice(0, 30));
  });

  it('produces different galaxies for different seeds', () => {
    expect(generateStars('seed-a')[0]).not.toEqual(generateStars('seed-b')[0]);
  });

  describe.each(SEEDS)('seed %j', (seed) => {
    const stars = generateStars(seed);

    it('is deterministic across calls', () => {
      expect(generateStars(seed)).toEqual(stars);
    });

    it('has unique ids that are 16 lowercase hex chars', () => {
      expect(new Set(stars.map((star) => star.id)).size).toBe(stars.length);
      for (const star of stars) expect(star.id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('has unique, non-empty names', () => {
      expect(new Set(stars.map((star) => star.name)).size).toBe(stars.length);
      for (const star of stars) expect(star.name).toMatch(/^[A-Z][a-z]+(-\d+)?$/);
    });

    it('keeps coordinates and system counts in range with finite, non-negative-zero numbers', () => {
      for (const star of stars) {
        expect(Math.sqrt(star.x * star.x + star.y * star.y)).toBeLessThanOrEqual(
          GALAXY_RADIUS + 0.01,
        );
        expect(Math.abs(star.z)).toBeLessThanOrEqual(6 * GALAXY_THICKNESS_SD + 0.001);
        expect(star.systemCount).toBeGreaterThanOrEqual(MIN_SYSTEM_COUNT);
        expect(star.systemCount).toBeLessThanOrEqual(MAX_SYSTEM_COUNT);
        for (const value of [star.x, star.y, star.z]) {
          expect(Number.isFinite(value)).toBe(true);
          expect(Object.is(value, -0)).toBe(false);
        }
      }
    });
  });

  it('follows the spectral weighting: O rare, K and M common', () => {
    const counts: Record<string, number> = {};
    for (const star of generateStars('distribution', 6000)) {
      counts[star.class] = (counts[star.class] ?? 0) + 1;
    }
    const share = (cls: string): number => (counts[cls] ?? 0) / 6000;
    expect(share('O')).toBeLessThan(0.02);
    expect(share('O')).toBeLessThan(share('B'));
    expect(share('K') + share('M')).toBeGreaterThan(0.6);
    expect(share('M')).toBeGreaterThan(share('G'));
    expect(share('G')).toBeGreaterThan(share('F'));
  });

  it('spreads stars as a thin disk: wide in x/y, thin in z', () => {
    const stars = generateStars('disk', 2000);
    const spread = (pick: (s: (typeof stars)[number]) => number): number =>
      Math.max(...stars.map((s) => Math.abs(pick(s))));
    expect(spread((s) => s.x)).toBeGreaterThan(300);
    expect(spread((s) => s.z)).toBeLessThan(110);
  });
});
