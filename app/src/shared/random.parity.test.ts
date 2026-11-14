import { describe, expect, it } from 'vitest';
import { Rng, hash2, hex64, seedFromString } from '@shared/random.ts';

// Golden values produced by an independent Python reference implementation of FNV-1a 64,
// splitmix64 and xoshiro128**. Runs under both vitest projects (node and jsdom).
const SEED = 'drift-dev-seed-001';

describe('PRNG golden values (seed "drift-dev-seed-001")', () => {
  it('derives the 64-bit seed', () => {
    expect(seedFromString(SEED)).toBe(9405853537432462590n);
    expect(hex64(seedFromString(SEED))).toBe('82884df53c0364fe');
  });

  it('produces the first 8 nextU32 values', () => {
    const rng = new Rng(seedFromString(SEED));
    const values = Array.from({ length: 8 }, () => rng.nextU32());
    expect(values).toEqual([
      2895375498, 208074824, 1414563111, 3686019327, 469910651, 4230074958, 204985150, 2539733442,
    ]);
  });

  it('produces the first nextF64 values (53 bits from two draws)', () => {
    const rng = new Rng(seedFromString(SEED));
    expect([rng.nextF64(), rng.nextF64(), rng.nextF64()]).toEqual([
      0.6741321388516291, 0.3293536443875599, 0.10940960038372183,
    ]);
  });

  it('produces the first nextInt(10) values', () => {
    const rng = new Rng(seedFromString(SEED));
    expect(Array.from({ length: 8 }, () => rng.nextInt(10))).toEqual([8, 4, 1, 7, 1, 8, 0, 2]);
  });

  it('produces the first nextGauss values', () => {
    const rng = new Rng(seedFromString(SEED));
    expect([rng.nextGauss(), rng.nextGauss(), rng.nextGauss()]).toEqual([
      -0.5669632237404585, -2.1468542451038957, 0.13883156655356288,
    ]);
  });

  it('hashes pairs of keys stably and asymmetrically', () => {
    const seed = seedFromString(SEED);
    expect(hex64(hash2(seed, 0n))).toBe('e0e852068803aa36');
    expect(hex64(hash2(seed, 1n))).toBe('4664bbe68ccc59ce');
    expect(hex64(hash2(1n, 2n))).toBe('bcd9dbb49673066b');
    expect(hex64(hash2(2n, 1n))).toBe('e06dd043328bd285');
  });

  it('is identical across fresh instances and call interleavings', () => {
    const a = new Rng(seedFromString(SEED));
    const b = new Rng(seedFromString(SEED));
    const first = [a.nextU32(), a.nextF64(), a.nextInt(1000)];
    expect([b.nextU32(), b.nextF64(), b.nextInt(1000)]).toEqual(first);
  });
});
