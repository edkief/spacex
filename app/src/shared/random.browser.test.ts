/**
 * @vitest-environment happy-dom
 *
 * Browser-environment parity suite: asserts the exact same golden constants as
 * the node-env suite in random.test.ts. Passing both proves the module yields
 * identical values in a DOM environment and in Node.
 */
import { describe, expect, it } from 'vitest';
import { Rng, hash2, seedFromString } from './random';

const SEED = 'drift-dev-seed-001';
const GOLDEN_SEED = 0x82884df53c0364fen;
const GOLDEN_U32 = [
  2267808275, 2076312506, 690160979, 3349814244, 3129127743, 2524879047, 1083215450, 1202438424,
];
const GOLDEN_F64 = [
  0.45845886575989425, 0.6665845445822924, 0.2878430034033954, 0.43585298443213105,
  0.40047425497323275,
];

describe('browser parity (happy-dom): identical golden outputs', () => {
  it('seedFromString matches node golden values', () => {
    expect(seedFromString('')).toBe(0xcbf29ce484222325n);
    expect(seedFromString('hello')).toBe(0xa430d84680aabd0bn);
    expect(seedFromString(SEED)).toBe(GOLDEN_SEED);
  });

  it('first 8 nextU32() and next 5 nextF64() match node golden values', () => {
    const rng = new Rng(GOLDEN_SEED);
    expect(Array.from({ length: 8 }, () => rng.nextU32())).toEqual(GOLDEN_U32);
    expect(Array.from({ length: 5 }, () => rng.nextF64())).toEqual(GOLDEN_F64);
  });

  it('hash2 matches node golden values', () => {
    expect(hash2(1n, 2n)).toBe(0xf893a2eefb32555en);
    expect(hash2(2n, 1n)).toBe(0xbfc846100bfc1e42n);
    expect(hash2(GOLDEN_SEED, GOLDEN_SEED)).toBe(0x6c675db51f343ab2n);
  });

  it('helpers behave identically (deterministic repeat)', () => {
    const a = new Rng(GOLDEN_SEED);
    const b = new Rng(GOLDEN_SEED);
    for (let i = 0; i < 200; i++) {
      expect(a.nextRange(-1, 1)).toBe(b.nextRange(-1, 1));
      expect(a.nextInt(1000)).toBe(b.nextInt(1000));
      expect(a.nextGauss(0, 1)).toBe(b.nextGauss(0, 1));
    }
  });
});
