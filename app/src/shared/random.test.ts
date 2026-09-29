/**
 * Golden-value + property tests for the deterministic PRNG library (node env).
 * Golden constants are also asserted in random.browser.test.ts (happy-dom) to
 * prove Node/browser parity — keep the two copies in sync.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { Rng, hash2, seedFromString } from './random';

const SEED = 'drift-dev-seed-001';
/** FNV-1a 64-bit of 'drift-dev-seed-001'. */
const GOLDEN_SEED = 0x82884df53c0364fen;
/** First 8 nextU32() values for seed 'drift-dev-seed-001'. */
const GOLDEN_U32 = [
  2267808275, 2076312506, 690160979, 3349814244, 3129127743, 2524879047, 1083215450, 1202438424,
];
/** First 5 nextF64() values (same seed, continuing the sequence above). */
const GOLDEN_F64 = [
  0.45845886575989425, 0.6665845445822924, 0.2878430034033954, 0.43585298443213105,
  0.40047425497323275,
];

describe('seedFromString (FNV-1a 64-bit)', () => {
  it('matches hardcoded golden values for 3 known strings', () => {
    // '' is the FNV-1a offset basis; 'hello' is the well-known test vector.
    expect(seedFromString('')).toBe(0xcbf29ce484222325n);
    expect(seedFromString('hello')).toBe(0xa430d84680aabd0bn);
    expect(seedFromString(SEED)).toBe(GOLDEN_SEED);
  });

  it('is order- and character-sensitive', () => {
    expect(seedFromString('abc')).not.toBe(seedFromString('bca'));
    expect(seedFromString('über-星')).toBe(0x77a6f74bc39e0255n);
  });

  it('always returns an unsigned 64-bit bigint', () => {
    for (const s of ['', 'a', SEED, 'über-星', 'x'.repeat(1000)]) {
      const h = seedFromString(s);
      expect(h >= 0n).toBe(true);
      expect(h <= 0xffffffffffffffffn).toBe(true);
    }
  });
});

describe('Rng golden values (seed drift-dev-seed-001)', () => {
  it('produces the hardcoded first 8 nextU32() values', () => {
    const rng = new Rng(GOLDEN_SEED);
    expect(Array.from({ length: 8 }, () => rng.nextU32())).toEqual(GOLDEN_U32);
  });

  it('produces the hardcoded next 5 nextF64() values', () => {
    const rng = new Rng(GOLDEN_SEED);
    for (let i = 0; i < 8; i++) rng.nextU32();
    expect(Array.from({ length: 5 }, () => rng.nextF64())).toEqual(GOLDEN_F64);
  });

  it('is deterministic: same seed + same calls => identical sequence', () => {
    const a = new Rng(seedFromString(SEED));
    const b = new Rng(seedFromString(SEED));
    for (let i = 0; i < 1000; i++) {
      expect(a.nextU32()).toBe(b.nextU32());
    }
  });

  it('different seeds diverge', () => {
    const a = new Rng(seedFromString(SEED));
    const b = new Rng(seedFromString('drift-dev-seed-002'));
    const seqA = Array.from({ length: 8 }, () => a.nextU32());
    const seqB = Array.from({ length: 8 }, () => b.nextU32());
    expect(seqA).not.toEqual(seqB);
  });

  it('survives an all-zeros seed without falling into the zero state', () => {
    const rng = new Rng(0n);
    const vals = Array.from({ length: 8 }, () => rng.nextU32());
    expect(new Set(vals).size).toBeGreaterThan(1);
    expect(vals.every((v) => Number.isInteger(v) && v >= 0 && v < 2 ** 32)).toBe(true);
  });
});

describe('derived helpers', () => {
  it('nextRange stays in [min, max)', () => {
    const rng = new Rng(GOLDEN_SEED);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.nextRange(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
    }
  });

  it('nextInt stays in [0, n) and covers the range', () => {
    const rng = new Rng(GOLDEN_SEED);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it('pick returns only elements of the array', () => {
    const rng = new Rng(GOLDEN_SEED);
    const arr = ['alpha', 'bravo', 'charlie'];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const v = rng.pick(arr);
      expect(arr).toContain(v);
      seen.add(v);
    }
    expect(seen.size).toBe(3);
  });

  it('nextGauss approximates the requested mean/sd', () => {
    const rng = new Rng(GOLDEN_SEED);
    const n = 100_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = rng.nextGauss(10, 2);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(mean).toBeCloseTo(10, 1);
    expect(sd).toBeCloseTo(2, 1);
  });
});

describe('hash2', () => {
  it('matches hardcoded golden values', () => {
    expect(hash2(1n, 2n)).toBe(0xf893a2eefb32555en);
    expect(hash2(2n, 1n)).toBe(0xbfc846100bfc1e42n);
    expect(hash2(GOLDEN_SEED, GOLDEN_SEED)).toBe(0x6c675db51f343ab2n);
    expect(hash2(0n, 0n)).toBe(0xe220a8397b1dcdafn);
  });

  it('is order-sensitive and returns unsigned 64-bit', () => {
    expect(hash2(1n, 2n)).not.toBe(hash2(2n, 1n));
    const h = hash2(-5n, 99n);
    expect(h >= 0n).toBe(true);
    expect(h <= 0xffffffffffffffffn).toBe(true);
  });

  it('gives independent-looking sub-seeds per entity pair', () => {
    const base = seedFromString(SEED);
    const a = new Rng(hash2(base, 1n));
    const b = new Rng(hash2(base, 2n));
    expect(a.nextU32()).not.toBe(b.nextU32());
  });
});

describe('purity: no non-deterministic APIs in random.ts source', () => {
  it('contains no Math.random / Date.now / crypto / performance.now / new Date', () => {
    const src = readFileSync(resolve(__dirname, 'random.ts'), 'utf8');
    // Strip comments so the doc block describing the rule cannot self-match.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of [
      /Math\.random/,
      /Date\.now/,
      /\bnew Date\b/,
      /\bcrypto\b/,
      /performance\.now/,
      /Math\.floor\(.*random/i,
    ]) {
      expect(code).not.toMatch(banned);
    }
  });
});

describe('distribution sanity (chi-square-lite)', () => {
  it('100k nextF64() samples are roughly uniform (bin deviation < 20%)', () => {
    const rng = new Rng(seedFromString(SEED));
    const bins = 10;
    const counts = new Array<number>(bins).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const v = rng.nextF64();
      const idx = Math.min(bins - 1, Math.floor(v * bins));
      counts[idx]++;
    }
    const expected = n / bins;
    for (let i = 0; i < bins; i++) {
      const deviation = Math.abs(counts[i] - expected) / expected;
      expect(deviation, `bin ${i}: ${counts[i]} (expected ${expected})`).toBeLessThan(0.2);
    }
  });
});
