// @vitest-environment happy-dom
/**
 * Node/browser parity + golden snapshot + source purity for
 * `shared/galaxy/surface`.
 *
 * Mirrors `system.parity.test.ts`:
 *   - The committed golden fixture must reproduce identically under the
 *     browser-ish happy-dom environment, proving the generator depends
 *     only on platform-independent primitives.
 *   - The source of `surface.ts` must remain free of `Math.random`,
 *     `Date.now`, `globalThis.*`, `crypto`, and `performance.now`, so
 *     no platform hook can sneak in and silently break determinism.
 *
 * Functional invariants (chunk shape, biome validity, node bounds,
 * boundary continuity, determinism) live in `surface.test.ts`; this
 * file is the cross-environment + tamper-detection portion of the
 * suite.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { generateStars } from "./stars.js";
import { generateSystemFromStar } from "./system.js";
import { generateSurfaceChunk } from "./surface.js";
import type { Planet, Star } from "./types.js";
import {
  computeHeightmapStats,
  sampleHeightmap16,
  sampleLandablePlanet,
  loadSurfaceFixture,
} from "./surface.helpers.js";
import { DEV_SEED } from "./surface.helpers.js";

// ---------------------------------------------------------------------------
// Golden snapshot fixture
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — golden fixture (chunk (0,0) of dev seed's first landable planet)", () => {
  it("committed fixture exists and is well-formed", () => {
    const fx = loadSurfaceFixture();
    expect(fx.seed).toBe(DEV_SEED);
    expect(fx.chunkX).toBe(0);
    expect(fx.chunkZ).toBe(0);
    expect(fx.planet.id).toMatch(/^[0-9a-f]{16}$/);
    expect(fx.heightmap16).toHaveLength(16);
    for (const h of fx.heightmap16) {
      expect(Number.isInteger(h)).toBe(true);
    }
    expect(fx.landingPads.length).toBeGreaterThanOrEqual(0);
    expect(fx.landingPads.length).toBeLessThanOrEqual(1);
  });

  it("regenerating the chunk from the fixture inputs reproduces heightmap16 + biome + nodes + pads (happy-dom)", () => {
    const fx = loadSurfaceFixture();
    // Reconstruct the planet from the fixture's planet id + the dev seed.
    const stars = generateStars(fx.seed);
    const star = stars[0] as Star;
    const sys = generateSystemFromStar(fx.seed, star);
    const planet = sys.planets.find((p) => p.id === fx.planet.id) as Planet;
    const chunk = generateSurfaceChunk(fx.seed, planet, fx.chunkX, fx.chunkZ);

    // Heightmap: 4×4 sample deep-equal.
    expect(sampleHeightmap16(chunk.heightmap)).toEqual(fx.heightmap16);

    // Heightmap stats.
    expect(computeHeightmapStats(chunk.heightmap)).toEqual(fx.heightmapStats);

    // Biome.
    expect(chunk.biome).toBe(fx.biome);

    // Resource nodes (deep equal).
    expect(chunk.resourceNodes).toEqual(fx.resourceNodes);

    // Landing pads (deep equal).
    expect(chunk.landingPads).toEqual(fx.landingPads);
  });

  it("planet picked by sampleLandablePlanet() matches the fixture's planet", () => {
    const fx = loadSurfaceFixture();
    const sample = sampleLandablePlanet();
    expect(sample.id).toBe(fx.planet.id);
  });

  it("golden fixture regenerates identically from a fresh Rng (no internal state leakage)", () => {
    // Two calls in the same process — determinism is a per-call contract,
    // not a per-process one. This guards against accidental caching.
    const fx = loadSurfaceFixture();
    const stars = generateStars(fx.seed);
    const star = stars[0] as Star;
    const sys = generateSystemFromStar(fx.seed, star);
    const planet = sys.planets.find((p) => p.id === fx.planet.id) as Planet;

    const a = generateSurfaceChunk(fx.seed, planet, fx.chunkX, fx.chunkZ);
    const b = generateSurfaceChunk(fx.seed, planet, fx.chunkX, fx.chunkZ);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Source purity
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — source purity (no platform hooks)", () => {
  it.each([["surface.ts"], ["surface-noise.ts"], ["surface-placement.ts"]])(
    "%s source contains no Math.random, Date.now, globalThis, crypto, performance",
    (filename) => {
      const here = dirname(fileURLToPath(import.meta.url));
      const path = resolve(here, `./${filename}`);
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
    },
  );
});
