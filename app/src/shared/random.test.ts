import { describe, expect, it } from 'vitest';
import { Rng, SplitMix64, hex64, seedFromString } from '@shared/random.ts';

describe('seedFromString (FNV-1a 64)', () => {
  it.each([
    ['', 'cbf29ce484222325'],
    ['a', 'af63dc4c8601ec8c'],
    ['foobar', '85944171f73967e8'],
  ])('matches the published vector for %j', (text, hex) => {
    expect(hex64(seedFromString(text))).toBe(hex);
  });

  it('hashes UTF-8 bytes, including astral characters and lone surrogates', () => {
    expect(hex64(seedFromString('é😀'))).toBe('52da6ebdce68376c');
    expect(seedFromString('\ud800')).toBe(seedFromString('�'));
  });
});

describe('hex64', () => {
  it('zero-pads to 16 lowercase hex chars', () => {
    expect(hex64(0n)).toBe('0000000000000000');
    expect(hex64(255n)).toBe('00000000000000ff');
    expect(hex64(-1n)).toBe('ffffffffffffffff');
  });
});

describe('SplitMix64', () => {
  it('matches the published vectors for seed 1234567', () => {
    const sm = new SplitMix64(1234567n);
    expect(sm.next()).toBe(6457827717110365317n);
    expect(sm.next()).toBe(3203168211198807973n);
    expect(sm.next()).toBe(9817491932198370423n);
  });
});

describe('xoshiro128** reference algorithm', () => {
  it('matches a hand-computed trace from state [1, 2, 3, 4]', () => {
    // Step 1: result = rotl(2*5, 7) * 9 = 10 * 128 * 9 = 11520.
    //   t = 2<<9 = 1024; s2 = 3^1 = 2; s3 = 4^2 = 6; s1 = 2^2 = 0; s0 = 1^6 = 7;
    //   s2 ^= t -> 1026; s3 = rotl(6, 11) = 12288.  State [7, 0, 1026, 12288].
    // Step 2: result = rotl(0, 7) * 9 = 0.
    //   t = 0; s2 = 1026^7 = 1029; s3 = 12288^0; s1 = 0^1029 = 1029; s0 = 7^12288 = 12295;
    //   s3 = rotl(12288, 11) = 25165824.  State [12295, 1029, 1029, 25165824].
    // Step 3: result = rotl(1029*5, 7) * 9 = 5145 * 128 * 9 = 5927040.
    const rng = Rng.fromState(1, 2, 3, 4);
    expect([rng.nextU32(), rng.nextU32(), rng.nextU32()]).toEqual([11520, 0, 5927040]);
  });

  it('wraps 32-bit multiplication and rotation correctly', () => {
    // s1 = 0xffffffff: s1*5 mod 2^32 = 0xfffffffb; rotl 7 = 0xfffffdff; *9 mod 2^32 = 4294962679.
    const rng = Rng.fromState(0, 0xffffffff, 0, 0);
    expect(rng.nextU32()).toBe(4294962679);
  });

  it('seeds via two splitmix64 outputs, low word first', () => {
    const rng = new Rng(1234567n);
    expect(Array.from({ length: 4 }, () => rng.nextU32())).toEqual([
      1967786208, 270031234, 1115494691, 824886977,
    ]);
  });

  it('rejects an all-zero state', () => {
    expect(() => Rng.fromState(0, 0, 0, 0)).toThrow(/zero/);
  });
});

describe('derived helpers', () => {
  it('nextF64 stays in [0, 1) and is uniform across 100k samples', () => {
    const rng = new Rng(seedFromString('uniformity'));
    const bins = new Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const value = rng.nextF64();
      expect(value >= 0 && value < 1).toBe(true);
      bins[Math.floor(value * 10)] = (bins[Math.floor(value * 10)] ?? 0) + 1;
    }
    for (const count of bins) expect(Math.abs(count - 10_000) / 10_000).toBeLessThan(0.2);
  });

  it('nextInt is in range and unbiased for a non-power-of-two n', () => {
    const rng = new Rng(seedFromString('ints'));
    const bins = new Array<number>(7).fill(0);
    for (let i = 0; i < 70_000; i++) {
      const value = rng.nextInt(7);
      bins[value] = (bins[value] ?? 0) + 1;
    }
    for (const count of bins) expect(Math.abs(count - 10_000) / 10_000).toBeLessThan(0.1);
    expect(new Rng(1n).nextInt(1)).toBe(0);
  });

  it('nextInt rejects invalid bounds', () => {
    const rng = new Rng(1n);
    for (const bad of [0, -1, 1.5, Number.NaN, 4294967297]) {
      expect(() => rng.nextInt(bad)).toThrow(RangeError);
    }
  });

  it('nextRange maps into [min, max)', () => {
    const rng = new Rng(2n);
    for (let i = 0; i < 1000; i++) {
      const value = rng.nextRange(-5, 5);
      expect(value >= -5 && value < 5).toBe(true);
    }
  });

  it('pick and pickWeighted choose valid members', () => {
    const rng = new Rng(3n);
    expect(['a', 'b', 'c']).toContain(rng.pick(['a', 'b', 'c']));
    expect(() => rng.pick([])).toThrow(RangeError);
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 10_000; i++) counts[rng.pickWeighted(['a', 'b'] as const, [1, 3])]++;
    expect(counts.b / counts.a).toBeGreaterThan(2.5);
    expect(counts.b / counts.a).toBeLessThan(3.5);
    expect(() => rng.pickWeighted(['a'], [0])).toThrow(RangeError);
  });

  it('nextGauss has mean ~0, sd ~1 and bounded tails', () => {
    const rng = new Rng(seedFromString('gauss'));
    const n = 50_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const z = rng.nextGauss();
      expect(Math.abs(z)).toBeLessThanOrEqual(6);
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / n;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(Math.sqrt(sumSq / n - mean * mean) - 1)).toBeLessThan(0.03);
    expect(new Rng(4n).nextGauss(10, 0)).toBe(10);
  });
});
