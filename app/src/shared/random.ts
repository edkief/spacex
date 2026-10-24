/**
 * Deterministic randomness and hashing primitives.
 * Used by all galaxy generation to ensure identical results across platforms.
 */

// FNV-1a 64-bit constants
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/**
 * Generates a 64-bit seed from a string using FNV-1a.
 * Deterministic across all JS environments.
 */
export function seedFromString(s: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    const charCode = BigInt(s.charCodeAt(i));
    hash ^= charCode;
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/**
 * Combines two 64-bit keys into one using a SplitMix64-style finalizer.
 */
export function hash2(a: bigint, b: bigint): bigint {
  let x = (a ^ b) & MASK64;
  x = (x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n;
  x = x & MASK64;
  x = (x ^ (x >> 27n)) * 0x94d049bb133111ebn;
  x = x & MASK64;
  x = x ^ (x >> 31n);
  return x & MASK64;
}

/**
 * Deterministic PRNG using xoshiro128** (32-bit state).
 */
export class Rng {
  private s0: number = 0;
  private s1: number = 0;
  private s2: number = 0;
  private s3: number = 0;

  constructor(seed: bigint) {
    this.seed(seed);
  }

  /**
   * Initializes the PRNG state from a seed.
   * Uses SplitMix64 to expand the 64-bit seed into 128 bits of state (4x32).
   */
  seed(seed: bigint): void {
    let state = seed & MASK64;

    const nextSplitMix = (): number => {
      state = (state + 0x9e3779b97f4a7c15n) & MASK64;
      let z = state;
      z = (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n;
      z = z & MASK64;
      z = (z ^ (z >> 27n)) * 0x94d049bb133111ebn;
      z = z & MASK64;
      z = z ^ (z >> 31n);
      return Number(z & 0xffffffffn);
    };

    this.s0 = nextSplitMix();
    this.s1 = nextSplitMix();
    this.s2 = nextSplitMix();
    this.s3 = nextSplitMix();
  }

  private rotl(x: number, k: number): number {
    return (x << k) | (x >>> (32 - k));
  }

  /**
   * Generates a random 32-bit unsigned integer.
   */
  nextU32(): number {
    const result = Math.imul(this.rotl(Math.imul(this.s0, 5), 7), 9);
    const t = this.s1 << 9;

    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = this.rotl(this.s3, 11);

    return result >>> 0;
  }

  /**
   * Generates a random float in [0, 1).
   * Note: 24-bit precision (nextU32 / 2^32).
   */
  nextF64(): number {
    return this.nextU32() / 0x100000000;
  }

  /**
   * Generates a random float in [min, max).
   */
  nextRange(min: number, max: number): number {
    return min + (max - min) * this.nextF64();
  }

  /**
   * Generates a random integer in [0, n).
   */
  nextInt(n: number): number {
    return Math.floor(this.nextF64() * n);
  }

  /**
   * Picks a random element from an array.
   */
  pick<T>(arr: readonly T[]): T {
    return arr[this.nextInt(arr.length)];
  }

  /**
   * Generates a random number with a Gaussian distribution.
   * Uses Box-Muller transform.
   */
  nextGauss(mean: number, sd: number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.nextF64();
    while (v === 0) v = this.nextF64();
    const mag = sd * Math.sqrt(-2.0 * Math.log(u));
    return mag * Math.cos(2.0 * Math.PI * v) + mean;
  }
}
