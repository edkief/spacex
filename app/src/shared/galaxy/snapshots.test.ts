/**
 * Galaxy determinism verification — TASK-6 snapshot suite.
 *
 * Locks the determinism contract for the three TASK-3/4/5 generators
 * (`stars`, `system`, `surface`) with committed snapshot fixtures.
 *
 * Each scenario in this file:
 *   1. Loads the corresponding committed fixture from
 *      `__fixtures__/` (JSON parsed once).
 *   2. Re-runs the generator from scratch using only the documented
 *      inputs (seed + indices).
 *   3. `toEqual`s the freshly-generated object against the fixture.
 *
 * On a mismatch the first divergent path is logged via
 * `firstDivergentPath` so the test output names the offending field
 * — handy when a tunable shift cascades into thousands of heightmap
 * cells.
 *
 * IMPORTANT: this test never writes to the fixtures. Regeneration is an
 * explicit, deliberate action performed by `npm run snapshot:update`
 * (see `__fixtures__/README.md`).
 *
 * The companion file `snapshots.mutation.test.ts` verifies the suite
 * actually catches drift by running a deliberately-mutated generator
 * and asserting the snapshot equality would break.
 *
 * @see ./stars.ts for the upstream star generator.
 * @see ./system.ts for the per-star system generator.
 * @see ./surface.ts for the per-chunk surface generator.
 * @see ./snapshots.helpers.ts for the shared fixture loaders and the
 *      divergent-path walker.
 */

import { describe, it, expect } from "vitest";

import { canonicalJson, starListChecksum } from "./canonical.js";
import { generateStars } from "./stars.js";
import { generateSystemFromStar } from "./system.js";
import { generateSurfaceChunk } from "./surface.js";
import { sampleHeightmap16 } from "./surface.helpers.js";
import type { Star } from "./types.js";
import {
  DEV_SEED,
  STAR0_INDEX,
  STAR1_INDEX,
  firstDivergentPath,
  loadFixture,
  loadPlanetFromSurfaceFixture,
  type StarsFixture,
  type SystemFixtureShape,
  type SurfaceFixtureShape,
} from "./snapshots.helpers.js";

// ---------------------------------------------------------------------------
// Scenario 1: full star chart
// ---------------------------------------------------------------------------

describe("snapshots — star chart (dev seed, full 200)", () => {
  it("regenerates the full chart byte-equal to the fixture", () => {
    const fx = loadFixture<StarsFixture>("stars-dev-seed-full.json");
    expect(fx.seed).toBe(DEV_SEED);
    expect(fx.count).toBe(fx.stars.length);

    const stars = generateStars(fx.seed);
    expect(stars.length).toBe(fx.count);

    if (canonicalJson(stars) !== canonicalJson(fx.stars)) {
      const path = firstDivergentPath(stars, fx.stars);
      throw new Error(
        `star chart diverges at ${path} — regenerate with \`npm run snapshot:update\``,
      );
    }
    expect(stars).toEqual(fx.stars);
  });

  it("star list checksum matches the fixture", () => {
    // The full-chart fixture ships a checksum for cross-validation.
    const fx = loadFixture<StarsFixture>("stars-dev-seed-full.json");
    const stars = generateStars(fx.seed);
    expect(starListChecksum(stars)).toBe(fx.checksum);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: system of star #0
// ---------------------------------------------------------------------------

describe("snapshots — system of star #0 (dev seed)", () => {
  it("regenerates the full SystemGen byte-equal to the fixture", () => {
    const fx = loadFixture<SystemFixtureShape>("system-dev-seed-star0.json");
    expect(fx.seed).toBe(DEV_SEED);
    expect(fx.starIndex).toBe(STAR0_INDEX);

    const stars = generateStars(fx.seed);
    const star = stars[fx.starIndex] as Star;
    expect(star.id).toBe(fx.starId);

    const system = generateSystemFromStar(fx.seed, star);

    if (canonicalJson(system) !== canonicalJson(fx.system)) {
      const path = firstDivergentPath(system, fx.system);
      throw new Error(
        `system #${fx.starIndex} diverges at ${path} — regenerate with \`npm run snapshot:update\``,
      );
    }
    expect(system).toEqual(fx.system);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: system of star #1
// ---------------------------------------------------------------------------

describe("snapshots — system of star #1 (dev seed)", () => {
  it("regenerates the full SystemGen byte-equal to the fixture", () => {
    const fx = loadFixture<SystemFixtureShape>("system-dev-seed-star1.json");
    expect(fx.seed).toBe(DEV_SEED);
    expect(fx.starIndex).toBe(STAR1_INDEX);

    const stars = generateStars(fx.seed);
    const star = stars[fx.starIndex] as Star;
    expect(star.id).toBe(fx.starId);

    const system = generateSystemFromStar(fx.seed, star);

    if (canonicalJson(system) !== canonicalJson(fx.system)) {
      const path = firstDivergentPath(system, fx.system);
      throw new Error(
        `system #${fx.starIndex} diverges at ${path} — regenerate with \`npm run snapshot:update\``,
      );
    }
    expect(system).toEqual(fx.system);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: surface chunk (0, 0) of the first landable planet
// ---------------------------------------------------------------------------

describe("snapshots — surface chunk (0,0) of star #0's first landable planet", () => {
  it("regenerates the chunk byte-equal to the fixture", () => {
    const fx = loadFixture<SurfaceFixtureShape>("surface-dev-seed-star0-planet0-chunk00.json");
    expect(fx.seed).toBe(DEV_SEED);
    expect(fx.chunkX).toBe(0);
    expect(fx.chunkZ).toBe(0);

    const planet = loadPlanetFromSurfaceFixture(fx);
    const chunk = generateSurfaceChunk(fx.seed, planet, fx.chunkX, fx.chunkZ);

    expect(chunk.chunkX).toBe(fx.chunkX);
    expect(chunk.chunkZ).toBe(fx.chunkZ);
    expect(chunk.biome).toBe(fx.biome);
    expect(chunk.resourceNodes).toEqual(fx.resourceNodes);
    expect(chunk.landingPads).toEqual(fx.landingPads);

    // Full heightmap equality (the fixture ships the full 4096-cell
    // heightmap so this catches fBm / lattice tuning drift).
    expect(chunk.heightmap).toEqual(fx.heightmap);

    // Sanity: the legacy 4×4 sample in the fixture must also agree
    // (used by surface.parity.test.ts; kept here as a cross-check).
    if (fx.heightmap16 !== undefined) {
      expect(sampleHeightmap16(chunk.heightmap)).toEqual(fx.heightmap16);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: surface chunk (1, 0)
// ---------------------------------------------------------------------------

describe("snapshots — surface chunk (1,0) of star #0's first landable planet", () => {
  it("regenerates the chunk byte-equal to the fixture", () => {
    const fx = loadFixture<SurfaceFixtureShape>("surface-dev-seed-star0-planet0-chunk10.json");
    expect(fx.seed).toBe(DEV_SEED);
    expect(fx.chunkX).toBe(1);
    expect(fx.chunkZ).toBe(0);

    const planet = loadPlanetFromSurfaceFixture(fx);
    const chunk = generateSurfaceChunk(fx.seed, planet, fx.chunkX, fx.chunkZ);

    expect(chunk.chunkX).toBe(fx.chunkX);
    expect(chunk.chunkZ).toBe(fx.chunkZ);
    expect(chunk.biome).toBe(fx.biome);
    expect(chunk.resourceNodes).toEqual(fx.resourceNodes);
    expect(chunk.landingPads).toEqual(fx.landingPads);
    expect(chunk.heightmap).toEqual(fx.heightmap);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: surface chunk (0, 1)
// ---------------------------------------------------------------------------

describe("snapshots — surface chunk (0,1) of star #0's first landable planet", () => {
  it("regenerates the chunk byte-equal to the fixture", () => {
    const fx = loadFixture<SurfaceFixtureShape>("surface-dev-seed-star0-planet0-chunk01.json");
    expect(fx.seed).toBe(DEV_SEED);
    expect(fx.chunkX).toBe(0);
    expect(fx.chunkZ).toBe(1);

    const planet = loadPlanetFromSurfaceFixture(fx);
    const chunk = generateSurfaceChunk(fx.seed, planet, fx.chunkX, fx.chunkZ);

    expect(chunk.chunkX).toBe(fx.chunkX);
    expect(chunk.chunkZ).toBe(fx.chunkZ);
    expect(chunk.biome).toBe(fx.biome);
    expect(chunk.resourceNodes).toEqual(fx.resourceNodes);
    expect(chunk.landingPads).toEqual(fx.landingPads);
    expect(chunk.heightmap).toEqual(fx.heightmap);
  });
});
