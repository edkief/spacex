import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateStars } from './stars';
import { canonicalJson } from '../canonical';
import { GALAXY_RADIUS, GALAXY_STAR_COUNT, GALAXY_THICKNESS, SPECTRAL_WEIGHTS } from './config';
import fixture from './__fixtures__/stars-dev-seed.json';

const DEV_SEED = fixture.seed;
const SEEDS = ['drift-dev-seed-001', 'galaxy-alpha', 'beta-2', 'Ω-unicode-∞', ''];

function checksum(stars: unknown[]): string {
  return createHash('sha256').update(canonicalJson(stars)).digest('hex');
}

describe('generateStars', () => {
  it('golden snapshot: deep-equals the committed fixture for the dev seed', () => {
    const stars = generateStars(DEV_SEED);
    expect(stars.length).toBe(fixture.totalStars);
    expect(stars.slice(0, 25)).toEqual(fixture.stars);
    expect(checksum(stars)).toBe(fixture.checksum);
  });

  it('defaults to GALAXY_STAR_COUNT (200) stars', () => {
    expect(GALAXY_STAR_COUNT).toBe(200);
    expect(generateStars('any-seed').length).toBe(200);
  });

  it('honors the count parameter and is a prefix of the full generation', () => {
    const full = generateStars('any-seed');
    const partial = generateStars('any-seed', 10);
    expect(partial.length).toBe(10);
    expect(partial).toEqual(full.slice(0, 10));
  });

  for (const seed of SEEDS) {
    describe(`seed "${seed}"`, () => {
      const stars = generateStars(seed, 300);

      it('is deterministic (two calls are deeply equal)', () => {
        expect(generateStars(seed, 300)).toEqual(stars);
      });

      it('has unique ids (16-hex) and unique names', () => {
        const ids = new Set(stars.map((s) => s.id));
        const names = new Set(stars.map((s) => s.name));
        expect(ids.size).toBe(stars.length);
        expect(names.size).toBe(stars.length);
        for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
      });

      it('keeps coordinates inside the galaxy bounds (thin disk)', () => {
        for (const s of stars) {
          const radius = Math.hypot(s.x, s.y);
          expect(radius).toBeLessThanOrEqual(GALAXY_RADIUS + 1e-9);
          expect(Math.abs(s.z)).toBeLessThanOrEqual(GALAXY_THICKNESS + 1e-9);
          expect(Number.isFinite(s.x)).toBe(true);
          expect(Number.isFinite(s.y)).toBe(true);
          expect(Number.isFinite(s.z)).toBe(true);
        }
      });

      it('assigns systemCount in [2, 8] and a valid spectral class', () => {
        const classes = new Set(SPECTRAL_WEIGHTS.map(([c]) => c));
        for (const s of stars) {
          expect(s.systemCount).toBeGreaterThanOrEqual(2);
          expect(s.systemCount).toBeLessThanOrEqual(8);
          expect(classes.has(s.class)).toBe(true);
        }
      });
    });
  }

  describe('spectral class distribution (seed drift-dev-seed-001, 200 stars)', () => {
    const counts = new Map<string, number>();
    for (const s of generateStars(DEV_SEED)) counts.set(s.class, (counts.get(s.class) ?? 0) + 1);

    it('is skewed like the weighting: O rare, K/M common', () => {
      const o = counts.get('O') ?? 0;
      const b = counts.get('B') ?? 0;
      const k = counts.get('K') ?? 0;
      const m = counts.get('M') ?? 0;
      expect(o + b).toBeLessThan(25); // expected ~12, allow generous slack
      expect(k + m).toBeGreaterThan(70); // expected ~98
    });
  });
});
