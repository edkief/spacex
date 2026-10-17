import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Rng, hash2, seedFromString } from "./random.js";

// ---------------------------------------------------------------------------
// Hardcoded reference values (captured from the implementation, then
// committed to the test so a future regression in the algorithm — even
// a "harmless" reordering of a constant — fails loudly).
//
// Source seed: "drift-dev-seed-001" (the canonical drift dev seed, also
// used by the integration tests in TASK-3 and TASK-4).
// ---------------------------------------------------------------------------

const DEV_SEED = "drift-dev-seed-001";

/** FNV-1a 64-bit of the dev seed, hex. */
const DEV_SEED_HEX = "82884df53c0364fe";

/** FNV-1a 64-bit of the empty string is the FNV offset basis. */
const EMPTY_STRING_HEX = "cbf29ce484222325";

/** FNV-1a 64-bit of "hello". */
const HELLO_HEX = "a430d84680aabd0b";

/** FNV-1a 64-bit of the production galaxy seed placeholder. */
const PROD_SEED_HEX = "a5b3125784e762be";

/** First 8 `nextU32()` outputs for the dev seed, hex. */
const FIRST_8_U32_HEX = [
  "d9048ceb",
  "fb6a1e0c",
  "33daca87",
  "98b7fb2b",
  "1271b12e",
  "4915824e",
  "9451d062",
  "c65fc9bc",
];

/** First 8 `nextF64()` outputs for the dev seed, high precision. */
const FIRST_8_F64 = [
  0.8477256845217198, 0.982087972573936, 0.20255723758600652, 0.5965573291759938,
  0.07204730389639735, 0.2854844513349235, 0.5793733824975789, 0.7748991092666984,
];

/** `hash2(1n, 2n)` output. */
const HASH2_1_2_HEX = "beeb8da1658eec67";

/** `hash2(DEV_SEED, 0n)` output. */
const HASH2_DEV_0_HEX = "c9bf989ddefc021f";

// ---------------------------------------------------------------------------
// Golden-value suite
// ---------------------------------------------------------------------------

describe("shared/random — golden values", () => {
  it("seedFromString matches FNV-1a 64-bit on known strings", () => {
    expect(seedFromString(DEV_SEED).toString(16)).toBe(DEV_SEED_HEX);
    expect(seedFromString("").toString(16)).toBe(EMPTY_STRING_HEX);
    expect(seedFromString("hello").toString(16)).toBe(HELLO_HEX);
    expect(seedFromString("DRIFT-SEED-0001").toString(16)).toBe(PROD_SEED_HEX);
  });

  it("seedFromString is stable across calls (no hidden state)", () => {
    for (let i = 0; i < 5; i++) {
      expect(seedFromString(DEV_SEED).toString(16)).toBe(DEV_SEED_HEX);
    }
  });

  it("Rng.nextU32() returns the expected sequence for the dev seed", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    for (let i = 0; i < FIRST_8_U32_HEX.length; i++) {
      expect(rng.nextU32().toString(16).padStart(8, "0")).toBe(FIRST_8_U32_HEX[i]);
    }
  });

  it("Rng.nextF64() returns the expected sequence for the dev seed", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    for (let i = 0; i < FIRST_8_F64.length; i++) {
      expect(rng.nextF64()).toBe(FIRST_8_F64[i]);
    }
  });

  it("Rng picks the same value on every construction with the same seed", () => {
    const a = new Rng(seedFromString(DEV_SEED));
    const b = new Rng(seedFromString(DEV_SEED));
    for (let i = 0; i < 32; i++) {
      expect(a.nextU32()).toBe(b.nextU32());
    }
  });

  it("Different seeds diverge immediately", () => {
    const a = new Rng(seedFromString(DEV_SEED));
    const b = new Rng(seedFromString("other-seed"));
    let sameCount = 0;
    for (let i = 0; i < 16; i++) {
      if (a.nextU32() === b.nextU32()) sameCount++;
    }
    // Astronomically unlikely that two different seeds match 16 times.
    expect(sameCount).toBeLessThan(2);
  });

  it("hash2 is stable and returns 64-bit values", () => {
    expect(hash2(1n, 2n).toString(16)).toBe(HASH2_1_2_HEX);
    expect(hash2(seedFromString(DEV_SEED), 0n).toString(16)).toBe(HASH2_DEV_0_HEX);
    const v = hash2(12345n, 67890n);
    expect(v >= 0n).toBe(true);
    expect(v < 1n << 64n).toBe(true);
  });

  it("hash2 is order-sensitive (a,b) !== (b,a)", () => {
    expect(hash2(1n, 2n)).not.toBe(hash2(2n, 1n));
  });
});

// ---------------------------------------------------------------------------
// API surface: derived helpers
// ---------------------------------------------------------------------------

describe("shared/random — derived helpers", () => {
  it("nextRange produces floats in [min, max)", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextRange(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
    }
  });

  it("nextInt produces integers in [0, n) with the right distribution", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    const counts = new Map<number, number>();
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const v = rng.nextInt(5);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    for (let i = 0; i < 5; i++) {
      const c = counts.get(i) ?? 0;
      // 20% tolerance on the expected 2000 per bucket.
      expect(c).toBeGreaterThan(1600);
      expect(c).toBeLessThan(2400);
    }
  });

  it("nextInt rejects non-positive or non-integer arguments", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(-3)).toThrow(RangeError);
    expect(() => rng.nextInt(1.5)).toThrow(RangeError);
  });

  it("pick returns an element of the array", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    const arr = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < 200; i++) {
      expect(arr).toContain(rng.pick(arr));
    }
  });

  it("pick rejects empty arrays", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("nextGauss produces samples with roughly the requested mean/sd", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    const N = 20_000;
    const mean = 5;
    const sd = 2;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const v = rng.nextGauss(mean, sd);
      sum += v;
      sumSq += v * v;
    }
    const m = sum / N;
    const v = sumSq / N - m * m;
    // Loose bounds — we just want to catch a sign flip or a missing sd.
    expect(Math.abs(m - mean)).toBeLessThan(0.1);
    expect(Math.abs(Math.sqrt(v) - sd)).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// Distribution sanity: 100k nextF64() samples must be roughly uniform.
// ---------------------------------------------------------------------------

describe("shared/random — distribution sanity", () => {
  it("nextF64() is uniform within 20% per bin over 100k samples", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    const BINS = 10;
    const N = 100_000;
    const expected = N / BINS;
    const observed = new Array<number>(BINS).fill(0);
    for (let i = 0; i < N; i++) {
      const v = rng.nextF64();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const bin = Math.min(BINS - 1, Math.floor(v * BINS));
      observed[bin]++;
    }
    // Per-bin check: every bin within 20% of expected.
    let maxRelDev = 0;
    for (let i = 0; i < BINS; i++) {
      const dev = Math.abs(observed[i] - expected) / expected;
      if (dev > maxRelDev) maxRelDev = dev;
      expect(dev).toBeLessThan(0.2);
    }
    // Chi-square-lite summary for logging-friendly output (no assertion
    // beyond the per-bin check above, but we log it so a failure shows
    // the actual deviation).
    const chi2 = observed.reduce((acc, o) => acc + (o - expected) ** 2 / expected, 0);
    // 9 degrees of freedom; 99% critical value ≈ 21.7. We expect ~9.
    expect(chi2).toBeLessThan(21.7);
    // Suppress unused-variable warning while still recording the value.
    void maxRelDev;
  });
});

// ---------------------------------------------------------------------------
// Purity: the source file must not pull in any non-deterministic globals.
// We read the file and assert the forbidden tokens are absent.
// ---------------------------------------------------------------------------

describe("shared/random — purity", () => {
  it("source contains no Math.random, Date.now, or crypto calls", () => {
    // Resolve the path relative to this test file (vitest runs from
    // project root, but we use fileURLToPath + dirname to be safe).
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "random.ts"), "utf8");
    // Strip line comments and block comments before scanning, so a
    // "we explicitly avoid Math.random here" note does not false-positive.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/Math\.random\b/);
    expect(stripped).not.toMatch(/Date\.now\b/);
    expect(stripped).not.toMatch(/Date\.constructor\b/);
    // crypto.getRandomValues / crypto.randomBytes / require("crypto") etc.
    expect(stripped).not.toMatch(/\bcrypto\b/);
    // globalThis.* access would let an attacker re-introduce randomness.
    expect(stripped).not.toMatch(/globalThis\./);
    // performance.now() is timing-derived and not deterministic across
    // sandbox restarts; even though it isn't strictly "random", it is
    // out of scope for the gen pipeline.
    expect(stripped).not.toMatch(/performance\.now\b/);
  });
});
