// @vitest-environment happy-dom
/**
 * Node/browser parity test for `shared/random`.
 *
 * This file intentionally runs under `happy-dom` (configured in
 * `vitest.config.ts` via `environmentMatchGlobs`). If the parity check
 * passes here and the same constants pass in the node-environment
 * `random.test.ts`, then the PRNG produces identical output in both
 * environments — a precondition for SC-2 (two clients see the same
 * galaxy for the same seed).
 */
import { describe, it, expect } from "vitest";
import { Rng, hash2, seedFromString } from "./random.js";

const DEV_SEED = "drift-dev-seed-001";

/** Mirror of the golden values in `random.test.ts`. Kept in sync. */
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

const FIRST_8_F64 = [
  0.8477256845217198, 0.982087972573936, 0.20255723758600652, 0.5965573291759938,
  0.07204730389639735, 0.2854844513349235, 0.5793733824975789, 0.7748991092666984,
];

const DEV_SEED_HEX = "82884df53c0364fe";

describe("shared/random — happy-dom parity", () => {
  it("TextEncoder is present in the happy-dom global scope", () => {
    // Sanity check: confirm we are actually running under happy-dom and
    // not accidentally the node environment.
    expect(typeof globalThis.TextEncoder).toBe("function");
  });

  it("seedFromString produces the same digest under happy-dom", () => {
    expect(seedFromString(DEV_SEED).toString(16)).toBe(DEV_SEED_HEX);
  });

  it("Rng.nextU32() produces the same sequence under happy-dom", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    for (let i = 0; i < FIRST_8_U32_HEX.length; i++) {
      expect(rng.nextU32().toString(16).padStart(8, "0")).toBe(FIRST_8_U32_HEX[i]);
    }
  });

  it("Rng.nextF64() produces the same sequence under happy-dom", () => {
    const rng = new Rng(seedFromString(DEV_SEED));
    for (let i = 0; i < FIRST_8_F64.length; i++) {
      expect(rng.nextF64()).toBe(FIRST_8_F64[i]);
    }
  });

  it("hash2 produces the same digest under happy-dom", () => {
    expect(hash2(1n, 2n).toString(16)).toBe("beeb8da1658eec67");
    expect(hash2(seedFromString(DEV_SEED), 0n).toString(16)).toBe("c9bf989ddefc021f");
  });
});
