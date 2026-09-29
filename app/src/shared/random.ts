/**
 * Shared deterministic PRNG + hash primitives.
 *
 * This module is the root of galaxy determinism: any impurity here breaks
 * server/client parity for the whole galaxy. Rules:
 * - Pure: no imports, no Math.random, no Date.now, no crypto, no network.
 * - BigInt for all 64-bit hashing (no Math.imul truncation surprises).
 * - Number (32-bit ops) inside the xoshiro128** core, which is exactly the
 *   algorithm's intended representation and is identical in Node/browsers.
 *
 * Precision tradeoff (documented per spec): nextF64() has ~24-bit mantissa
 * precision (nextU32() / 2^32). That is fine for galaxy generation; do not
 * use it as a source for cryptographic or high-precision simulation work.
 */

const MASK64 = 0xffffffffffffffffn;
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
/** Golden ratio conjugate, used by splitmix64. */
const SM64_GAMMA = 0x9e3779b97f4a7c15n;

const utf8Encoder = new TextEncoder();

/**
 * FNV-1a 64-bit over the UTF-8 bytes of `s`, returned as a positive BigInt.
 * Deterministic across platforms (BigInt arithmetic only).
 * The empty string hashes to the FNV-1a 64-bit offset basis.
 */
export function seedFromString(s: string): bigint {
  let h = FNV64_OFFSET;
  for (const byte of utf8Encoder.encode(s)) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h;
}

/**
 * splitmix64 finalizer: one round of mix, no seed increment.
 * Maps any 64-bit input to a well-mixed 64-bit output.
 */
function splitmixFinalizer(z: bigint): bigint {
  let x = (z + SM64_GAMMA) & MASK64;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (x ^ (x >> 31n)) & MASK64;
}

/**
 * Combine two 64-bit keys (e.g. a galaxy seed and a system id) into a new
 * well-mixed 64-bit sub-seed. Order-sensitive and stable across platforms.
 */
export function hash2(a: bigint, b: bigint): bigint {
  const mixed = (b & MASK64) * SM64_GAMMA;
  const combined = (a ^ mixed) & MASK64;
  return splitmixFinalizer(combined);
}

/**
 * xoshiro128** over 4 x U32 state, seeded from a 128-bit seed via splitmix64.
 *
 * Determinism contract: same seed + same call sequence => identical values,
 * in Node and in the browser. Never share one instance across divergent call
 * sequences; make a fresh Rng (ideally from hash2) per entity.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: bigint) {
    this.s0 = 0;
    this.s1 = 0;
    this.s2 = 0;
    this.s3 = 0;
    let z = seed & MASK64;
    for (let i = 0; i < 4; i++) {
      const v = Number(splitmixFinalizer(z));
      if (i === 0) this.s0 = v;
      else if (i === 1) this.s1 = v;
      else if (i === 2) this.s2 = v;
      else this.s3 = v;
      z = (z + SM64_GAMMA) & MASK64;
    }
    // xoshiro is undefined at the all-zeros state; nudge it deterministically.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 0x12345678;
  }

  /** Left-rotate a U32. */
  private static rotl(x: number, k: number): number {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
  }

  /** Next unsigned 32-bit integer (xoshiro128** core). */
  nextU32(): number {
    const result = Math.imul(Rng.rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) | (this.s0 >>> 23);

    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = Rng.rotl(this.s3, 11);

    return result;
  }

  /** Next float in [0, 1) with 24-bit mantissa precision (see module note). */
  nextF64(): number {
    return this.nextU32() / 0x100000000;
  }

  /** Next float in [min, max). */
  nextRange(min: number, max: number): number {
    return min + this.nextF64() * (max - min);
  }

  /**
   * Next integer in [0, n). Uniform up to n <= 2^32; uses rejection-free
   * modulo, so modulo bias is at most 1/n (fine for generation, not for
   * cryptography).
   */
  nextInt(n: number): number {
    if (n <= 0) return 0;
    return this.nextU32() % n;
  }

  /** Pick a random element from a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.nextInt(arr.length)];
  }

  /**
   * Next sample from a (non-cached) Box-Muller normal with the given
   * mean and standard deviation.
   */
  nextGauss(mean = 0, sd = 1): number {
    let u1: number;
    do {
      u1 = this.nextF64();
    } while (u1 <= Number.EPSILON); // log(0) guard
    const u2 = this.nextF64();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + sd * z;
  }
}
