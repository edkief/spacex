// @vitest-environment happy-dom
/**
 * Node/browser parity + golden snapshot + source purity for
 * `shared/galaxy/system`.
 *
 * Mirrors `stars.parity.test.ts`:
 *   - The committed golden fixture must reproduce identically under the
 *     browser-ish happy-dom environment, proving the generator depends
 *     only on platform-independent primitives (BigInt arithmetic,
 *     TextEncoder, Math.* — none of which diverge across our targets).
 *   - The source of `system.ts` must remain free of `Math.random`,
 *     `Date.now`, `globalThis.*`, `crypto`, and `performance.now`, so
 *     no platform hook can sneak in and silently break determinism.
 *
 * Functional invariants (planet count, ordering, dock bounds, etc.)
 * live in `system.test.ts`; this file is the cross-environment +
 * tamper-detection portion of the suite.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { generateStars } from "./stars.js";
import { generateSystemFromStar } from "./system.js";
import type { Star } from "./types.js";
import { DEV_SEED, loadSystemFixture } from "./system.helpers.js";

// ---------------------------------------------------------------------------
// Golden snapshot fixture
// ---------------------------------------------------------------------------

describe("shared/galaxy/system — golden fixture (star #0 of dev seed)", () => {
  it("committed fixture exists and is well-formed", () => {
    const fx = loadSystemFixture();
    expect(fx.seed).toBe(DEV_SEED);
    expect(fx.starIndex).toBe(0);
    expect(fx.starId).toMatch(/^[0-9a-f]{16}$/);
    expect(fx.system.systemId).toMatch(/^[0-9a-f]{16}$/);
    expect(fx.system.planets.length).toBeGreaterThanOrEqual(2);
    expect(fx.system.planets.length).toBeLessThanOrEqual(6);
  });

  it("regenerating the system from the fixture reproduces it exactly (happy-dom)", () => {
    const fx = loadSystemFixture();
    const stars = generateStars(fx.seed);
    const star = stars[fx.starIndex] as Star;
    const sys = generateSystemFromStar(fx.seed, star);
    expect(sys).toEqual(fx.system);
  });

  it("golden systemId matches the freshly-computed value (byte-stable parity)", () => {
    const fx = loadSystemFixture();
    const stars = generateStars(fx.seed);
    const star = stars[fx.starIndex] as Star;
    expect(generateSystemFromStar(fx.seed, star).systemId).toBe(fx.system.systemId);
  });
});

// ---------------------------------------------------------------------------
// Source purity
// ---------------------------------------------------------------------------

describe("shared/galaxy/system — source purity (no platform hooks)", () => {
  it("system.ts source contains no Math.random, Date.now, globalThis, crypto, performance", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, "./system.ts");
    const src = readFileSync(path, "utf8");
    // Strip comments and string literals so future doc-comment
    // expansions that *name* a forbidden platform hook don't break us.
    const codeOnly = src
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    expect(codeOnly).not.toMatch(/Math\.random/);
    expect(codeOnly).not.toMatch(/Date\.now/);
    expect(codeOnly).not.toMatch(/Date\.constructor/);
    expect(codeOnly).not.toMatch(/globalThis/);
    expect(codeOnly).not.toMatch(/\bcrypto\b/);
    expect(codeOnly).not.toMatch(/performance\.now/);
  });
});
