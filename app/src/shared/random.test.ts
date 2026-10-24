import { describe, it, expect } from 'vitest';
import { seedFromString, Rng, hash2 } from './random';
import fs from 'node:fs';
import path from 'node:path';

describe('Deterministic PRNG and Hashing', () => {
  const GOLDEN_SEED_STR = 'drift-dev-seed-001';
  const GOLDEN_VALUES = [
    803962117, 2222453413, 3836096833, 2805990346, 1473977797, 2381959626, 153432937, 2196972030,
  ];

  it('should produce identical results for the golden seed', () => {
    const seed = seedFromString(GOLDEN_SEED_STR);
    const rng = new Rng(seed);
    for (let i = 0; i < GOLDEN_VALUES.length; i++) {
      expect(rng.nextU32()).toBe(GOLDEN_VALUES[i]);
    }
  });

  it('seedFromString should be deterministic', () => {
    const s = 'test-seed';
    expect(seedFromString(s)).toBe(seedFromString(s));
    expect(seedFromString(s)).not.toBe(seedFromString('test-seed-2'));
  });

  it('hash2 should be deterministic and stable', () => {
    const a = 123456789n;
    const b = 987654321n;
    const h1 = hash2(a, b);
    const h2 = hash2(a, b);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(hash2(a, b + 1n));
  });

  it('should be uniformly distributed (chi-square lite)', () => {
    const rng = new Rng(seedFromString('dist-test'));
    const bins = new Array(10).fill(0);
    const samples = 100000;
    for (let i = 0; i < samples; i++) {
      const val = rng.nextF64();
      bins[Math.floor(val * 10)]++;
    }

    const expected = samples / 10;
    for (let i = 0; i < bins.length; i++) {
      const deviation = Math.abs(bins[i] - expected) / expected;
      expect(deviation).toBeLessThan(0.2);
    }
  });

  it('nextGauss should produce values around the mean', () => {
    const rng = new Rng(seedFromString('gauss-test'));
    const mean = 10;
    const sd = 2;
    let sum = 0;
    const samples = 10000;
    for (let i = 0; i < samples; i++) {
      sum += rng.nextGauss(mean, sd);
    }
    const average = sum / samples;
    expect(average).toBeCloseTo(mean, 1);
  });

  it('pick should return elements from the array', () => {
    const rng = new Rng(seedFromString('pick-test'));
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) {
      expect(arr).toContain(rng.pick(arr));
    }
  });

  it('nextRange should be within bounds', () => {
    const rng = new Rng(seedFromString('range-test'));
    for (let i = 0; i < 100; i++) {
      const val = rng.nextRange(5, 10);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThan(10);
    }
  });

  it('should not use Math.random', () => {
    const content = fs.readFileSync(path.resolve(__dirname, './random.ts'), 'utf8');
    expect(content).not.toContain('Math.random');
    expect(content).not.toContain('Date.now');
  });
});
