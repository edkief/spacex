/**
 * Deterministic hashing and PRNG primitives shared verbatim by browser and Node.
 *
 * Cross-engine rule: only exactly-specified operations are used here (+ - * /, Math.sqrt,
 * floor/ceil/round/trunc/abs/min/max/imul, integer and BigInt ops). Transcendental Math
 * functions are not required to be correctly rounded and differ between JS engines, so they
 * are banned in this file by an eslint rule and a source-scan test.
 */

const MASK_64 = (1n << 64n) - 1n;
const TWO_POW_32 = 4294967296;
const TWO_POW_26 = 67108864;
const TWO_POW_53 = 9007199254740992;

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const SPLITMIX_MUL_1 = 0xbf58476d1ce4e5b9n;
const SPLITMIX_MUL_2 = 0x94d049bb133111ebn;

/** Encodes a string as UTF-8 bytes (lone surrogates become U+FFFD, matching TextEncoder). */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63));
      bytes.push(0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return bytes;
}

/** FNV-1a 64-bit hash of the string's UTF-8 bytes, as an unsigned bigint. */
export function seedFromString(text: string): bigint {
  let hash = FNV_OFFSET_64;
  for (const byte of utf8Bytes(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME_64) & MASK_64;
  }
  return hash;
}

/** The splitmix64 output finalizer (a strong 64-bit bit mixer). */
function mix64(value: bigint): bigint {
  let z = value & MASK_64;
  z = ((z ^ (z >> 30n)) * SPLITMIX_MUL_1) & MASK_64;
  z = ((z ^ (z >> 27n)) * SPLITMIX_MUL_2) & MASK_64;
  return z ^ (z >> 31n);
}

/** splitmix64 generator (Vigna); used to expand a 64-bit seed into xoshiro state. */
export class SplitMix64 {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & MASK_64;
  }

  /** Advances the state by the golden-gamma and returns the next 64-bit output. */
  next(): bigint {
    this.state = (this.state + SPLITMIX_GAMMA) & MASK_64;
    return mix64(this.state);
  }
}

/**
 * Combines two 64-bit keys into a new 64-bit key for per-entity sub-seeds.
 * Defined as `mix64(mix64(a + G) + b + G)` with G the splitmix64 golden gamma, all mod 2^64.
 * Not symmetric: hash2(a, b) differs from hash2(b, a).
 */
export function hash2(a: bigint, b: bigint): bigint {
  return mix64(mix64(a + SPLITMIX_GAMMA) + b + SPLITMIX_GAMMA);
}

/** Formats a 64-bit hash as the canonical id: 16 lowercase hex chars, zero-padded. */
export function hex64(value: bigint): string {
  return (value & MASK_64).toString(16).padStart(16, '0');
}

/** Rotates a 32-bit unsigned integer left by `k` bits (0 < k < 32). */
function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * xoshiro128** PRNG (Blackman & Vigna) over four 32-bit words, using Number math with
 * `Math.imul` and `>>> 0` so every step is exact in any JS engine.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /** Seeds from a 64-bit value: two splitmix64 outputs fill the four state words (low word first). */
  constructor(seed: bigint) {
    const sm = new SplitMix64(seed);
    const a = sm.next();
    const b = sm.next();
    this.s0 = Number(a & 0xffffffffn);
    this.s1 = Number(a >> 32n);
    this.s2 = Number(b & 0xffffffffn);
    this.s3 = Number(b >> 32n);
  }

  /** Builds an Rng directly from raw state words (for reference-vector tests). Must not be all zero. */
  static fromState(s0: number, s1: number, s2: number, s3: number): Rng {
    if ((s0 | s1 | s2 | s3) === 0) throw new Error('xoshiro128 state must not be all zero');
    const rng = new Rng(0n);
    rng.s0 = s0 >>> 0;
    rng.s1 = s1 >>> 0;
    rng.s2 = s2 >>> 0;
    rng.s3 = s3 >>> 0;
    return rng;
  }

  /** Next unsigned 32-bit integer: `rotl(s1 * 5, 7) * 9`, then the standard state transition. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /**
   * Uniform float in [0, 1) with 53 bits of precision, built from two draws:
   * `((a >>> 5) * 2^26 + (b >>> 6)) / 2^53`. Every intermediate is an exact integer or a
   * power-of-two scaling, so the result is identical in every engine.
   */
  nextF64(): number {
    const high = this.nextU32() >>> 5;
    const low = this.nextU32() >>> 6;
    return (high * TWO_POW_26 + low) / TWO_POW_53;
  }

  /** Uniform float in [min, max). */
  nextRange(min: number, max: number): number {
    return min + this.nextF64() * (max - min);
  }

  /**
   * Unbiased integer in [0, n) for integer 1 <= n <= 2^32, by rejection: draws at or above the
   * largest multiple of n below 2^32 are discarded (expected extra draws < 1 for n <= 2^31).
   */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) {
      throw new RangeError(`nextInt(n) needs an integer in [1, 2^32], got ${n}`);
    }
    const limit = TWO_POW_32 - (TWO_POW_32 % n);
    let draw = this.nextU32();
    while (draw >= limit) draw = this.nextU32();
    return draw % n;
  }

  /** True with probability `p` (clamped by comparison semantics: p <= 0 never, p >= 1 always). */
  chance(p: number): boolean {
    return this.nextF64() < p;
  }

  /** Uniformly picks an element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() needs a non-empty array');
    return items[this.nextInt(items.length)] as T;
  }

  /** Picks an item with probability proportional to its non-negative weight. */
  pickWeighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0 || items.length !== weights.length) {
      throw new RangeError('pickWeighted() needs equal-length, non-empty items and weights');
    }
    let total = 0;
    for (const weight of weights) total += weight;
    if (!(total > 0)) throw new RangeError('pickWeighted() needs a positive total weight');
    let target = this.nextF64() * total;
    for (let i = 0; i < items.length; i++) {
      target -= weights[i] as number;
      if (target < 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  /**
   * Approximately normal sample (Irwin-Hall): the sum of 12 uniform u32 draws, scaled to
   * mean 0 and variance 1, then `mean + sd * z`. The sum of 12 integers is exact in a double,
   * so no log/cos is needed. Tails are bounded at +/-6 sd (true normal tails are unbounded) and
   * excess kurtosis is about -0.1; fine for placement jitter, not for statistical simulation.
   */
  nextGauss(mean = 0, sd = 1): number {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += this.nextU32();
    return mean + sd * (sum / TWO_POW_32 - 6);
  }
}
