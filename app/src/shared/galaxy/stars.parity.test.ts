// @vitest-environment happy-dom
/**
 * Node/browser parity test for `shared/galaxy/stars`.
 *
 * Mirrors the pattern from `random.parity.test.ts`: the same golden
 * values must hold under happy-dom (browser-ish environment) as they
 * do under the default node environment. If this test ever fails
 * alongside a passing `stars.test.ts`, we have a browser-specific
 * determinism bug — usually a Math.* difference that should be
 * folded into the canonical precision rounding in `stars.ts`.
 *
 * We deliberately load the fixture rather than hardcoding the first
 * 25 stars — a single source of truth is easier to keep in sync.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { generateStars } from "./stars.js";
import { starListChecksum } from "./canonical.js";
import type { Star } from "./types.js";

const DEV_SEED = "drift-dev-seed-001";

/**
 * Read the committed fixture. We mirror its shape into a typed local
 * structure so the test self-updates when the fixture changes.
 */
interface Fixture {
  seed: string;
  count: number;
  checksum: string;
  first25: Star[];
}

function loadFixture(): Fixture {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "__fixtures__/stars-dev-seed.json");
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

describe("shared/galaxy/stars — happy-dom parity", () => {
  it("TextEncoder is present in the happy-dom global scope", () => {
    expect(typeof globalThis.TextEncoder).toBe("function");
  });

  it("generateStars produces the same first 25 entries under happy-dom", () => {
    const fx = loadFixture();
    const stars = generateStars(fx.seed);
    expect(stars.slice(0, 25)).toEqual(fx.first25);
  });

  it("starListChecksum produces the same digest under happy-dom", () => {
    const fx = loadFixture();
    const stars = generateStars(fx.seed);
    expect(starListChecksum(stars)).toBe(fx.checksum);
  });

  it("DEV_SEED fixture checksum matches the recorded one", () => {
    // Cross-environment guard: if the fixture was last regenerated under
    // a different environment, this test catches it immediately.
    const fx = loadFixture();
    expect(fx.seed).toBe(DEV_SEED);
    expect(starListChecksum(generateStars(DEV_SEED))).toBe(fx.checksum);
  });
});
