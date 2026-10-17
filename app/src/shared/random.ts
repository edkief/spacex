/**
 * Shared deterministic PRNG + hash primitives.
 *
 * This module is the root of galaxy determinism (SC-2 in the PRD): every
 * downstream generator — stars, systems, surface chunks, AI placement,
 * resource nodes — must derive all randomness from here. If any impurity
 * sneaks in (e.g. `Math.random`, `Date.now`, `crypto.getRandomValues`),
 * two clients joining with the same `GALAXY_SEED` will diverge and the
 * shared universe is broken.
 *
 * Design constraints (from TASK-2 spec):
 * - Pure TypeScript, zero imports (no Node `crypto`, no browser `crypto`,
 *   no `Math.random`, no `Date`). The only platform primitive is
 *   `TextEncoder` (for UTF-8 bytes of `seedFromString`).
 * - Identical results in Node and the browser. The arithmetic is
 *   32-bit-safe (Number, with `>>> 0` to coerce to U32) plus BigInt for
 *   64-bit hashing where the bit width matters.
 * - Algorithms: FNV-1a 64-bit for `seedFromString`, xoshiro128** for
 *   `Rng`, splitmix64 finalizer for `hash2`.
 *
 * @see https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
 * @see https://prng.di.unimi.it/xoshiro128starstar.c
 * @see https://prng.di.unimi.it/splitmix64.c
 */

// ---------------------------------------------------------------------------
// 64-bit masks and FNV-1a constants
// ---------------------------------------------------------------------------

/** Mask keeping only the low 64 bits of a BigInt. */
const MASK_64 = (1n << 64n) - 1n;

/** Mask keeping only the low 32 bits as a Number. */
const MASK_32 = 0xffffffff >>> 0;

/** FNV-1a 64-bit offset basis. */
const FNV_OFFSET_BIG = 0xcbf29ce484222325n;

/** FNV-1a 64-bit prime. */
const FNV_PRIME_BIG = 0x100000001b3n;

/** splitmix64 increment (the 64-bit fractional part of the golden ratio). */
const SPLITMIX64_INC = 0x9e3779b97f4a7c15n;

// ---------------------------------------------------------------------------
// String → 64-bit seed (FNV-1a)
// ---------------------------------------------------------------------------

/**
 * Hashes a string to a 64-bit FNV-1a digest, returned as a `bigint` in the
 * range `[0, 2^64)`. UTF-8 encoded; identical across Node and the browser
 * because we use `TextEncoder` (universally available) and BigInt arithmetic
 * (no `Math.imul` truncation surprises).
 *
 * Use this to convert a human-readable seed (e.g. `"DRIFT-SEED-0001"` or
 * `"drift-dev-seed-001"`) into a numeric value the `Rng` can consume.
 */
export function seedFromString(s: string): bigint {
  const bytes = textEncodeUtf8(s);
  let hash = FNV_OFFSET_BIG;
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash ^ BigInt(bytes[i])) & MASK_64;
    hash = (hash * FNV_PRIME_BIG) & MASK_64;
  }
  return hash;
}

/**
 * Returns the UTF-8 byte sequence for `s`. Prefers `TextEncoder`; falls
 * back to a manual encoder only if the platform is so ancient that
 * `TextEncoder` is missing (we have not seen this in practice, but the
 * fallback keeps the module truly dependency-free).
 */
function textEncodeUtf8(s: string): Uint8Array {
  const Enc = (globalThis as { TextEncoder?: typeof TextEncoder }).TextEncoder;
  if (Enc) return new Enc().encode(s);
  // Manual UTF-8 encode (matches TextEncoder for code points ≤ 0xFFFF;
  // the drift codebase never uses supplementary-plane strings in seeds).
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// splitmix64 (used to expand seeds and to finalise `hash2`)
// ---------------------------------------------------------------------------

/**
 * One round of splitmix64: returns the next 64-bit value and updates the
 * state in place. Used to expand a 64-bit seed into a 128-bit (4×U32) Rng
 * state, and to finalise `hash2` for per-entity sub-seeds.
 *
 * Reference: Steele, Lea & Flood, 2014.
 */
function splitmix64(state: bigint): { value: bigint; next: bigint } {
  let z = (state + SPLITMIX64_INC) & MASK_64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
  z = z ^ (z >> 31n);
  return { value: z, next: z };
}

// ---------------------------------------------------------------------------
// xoshiro128** PRNG
// ---------------------------------------------------------------------------

/** 32-bit left rotation. Keeps the result in the U32 range. */
function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Deterministic 32-bit PRNG with a 4×U32 state (128 bits), running the
 * xoshiro128** generator by Blackman & Vigna.
 *
 * Why xoshiro128** (and not the + variant): the ** scrambles output bits
 * via multiplication, which gives better statistical quality for the
 * small state size while still being one of the fastest non-cryptographic
 * PRNGs in existence. 24 bits of `nextF64()` precision (one U32 / 2^32)
 * is more than enough for galaxy generation; documented in the spec.
 *
 * @see https://prng.di.unimi.it/xoshiro128starstar.c
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /**
   * Builds an `Rng` from any-width `bigint` seed. Internally we run
   * splitmix64 four times to derive the 4×U32 state — this both
   * decorrelates close seeds and stays deterministic across platforms
   * (BigInt arithmetic, no platform-dependent ops).
   */
  constructor(seed: bigint) {
    // Mix the seed up front so that two seeds that differ only in their
    // upper bits still produce wildly different states.
    let state = seed & MASK_64;
    const a = splitmix64(state);
    state = a.next ^ 0xdeadbeefcafebaben;
    const b = splitmix64(state);
    state = b.next ^ 0x123456789abcdef0n;
    const c = splitmix64(state);
    state = c.next ^ 0xfedcba9876543210n;
    const d = splitmix64(state);

    this.s0 = lowU32(a.value);
    this.s1 = lowU32(b.value);
    this.s2 = lowU32(c.value);
    this.s3 = lowU32(d.value);

    // Reject the all-zero state (xoshiro128** is degenerate if state=0).
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      this.s0 = 0xdeadbeef >>> 0;
    }
  }

  /** Returns the next 32-bit unsigned integer. */
  nextU32(): number {
    const result = rotl32(Math.imul(this.s1, 5) >>> 0, 7);
    const out = Math.imul(result, 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;

    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl32(this.s3, 11);

    return out;
  }

  /**
   * Returns a float in `[0, 1)`. 24 bits of precision (one U32 over 2^32),
   * which is sufficient for galaxy generation. If you need full 53-bit
   * double precision, combine two `nextU32()` calls yourself.
   */
  nextF64(): number {
    return this.nextU32() / 4294967296; // 2^32
  }

  /**
   * Returns a float in `[min, max)`. `min` must be < `max`; behaviour is
   * unspecified if the range is empty or inverted.
   */
  nextRange(min: number, max: number): number {
    return min + (max - min) * this.nextF64();
  }

  /**
   * Returns a non-negative integer in `[0, n)`. Uses `nextF64()` so the
   * distribution is uniform to the same 24-bit precision as the rest of
   * the API. `n` must be a positive integer.
   */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError(`Rng.nextInt(n): n must be a positive integer, got ${n}`);
    }
    return Math.floor(this.nextF64() * n);
  }

  /**
   * Returns a uniformly chosen element of `arr`. Throws on empty input.
   */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) {
      throw new RangeError("Rng.pick(arr): arr must be non-empty");
    }
    return arr[this.nextInt(arr.length)];
  }

  /**
   * Returns a Gaussian sample with the given `mean` and standard
   * deviation `sd`, via the Box–Muller transform. Consumes two uniforms
   * (the second is used to pick a polar angle; the radial component is
   * derived deterministically). Defaults to a standard normal N(0, 1).
   */
  nextGauss(mean = 0, sd = 1): number {
    // Reject 0 to avoid log(0); re-roll until both uniforms are in (0, 1].
    let u = 0;
    while (u === 0) u = this.nextF64();
    let v = 0;
    while (v === 0) v = this.nextF64();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return z * sd + mean;
  }
}

/** Extracts the low 32 bits of a BigInt as a U32 Number. */
function lowU32(x: bigint): number {
  return Number(x & 0xffffffffn) & MASK_32;
}

// ---------------------------------------------------------------------------
// hash2: 64-bit mixer for per-entity sub-seeds
// ---------------------------------------------------------------------------

/**
 * Combines two 64-bit keys into a 64-bit hash, suitable for deriving a
 * per-entity sub-seed from `(galaxySeed, entityId)`. The implementation
 * is the splitmix64 finalizer preceded by a XOR-multiply mix of the two
 * inputs — enough avalanche for sub-seed decorrelation, but explicitly
 * *not* a cryptographic hash (do not use for security purposes).
 */
export function hash2(a: bigint, b: bigint): bigint {
  // Mix: take the first key, XOR with the second multiplied by the
  // splitmix increment (a common high-avalanche combiner).
  let z = (a ^ (b * SPLITMIX64_INC)) & MASK_64;
  // splitmix64 finalizer (without the increment, since the input is
  // already mixed).
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
  z = z ^ (z >> 31n);
  return z & MASK_64;
}
