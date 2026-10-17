/**
 * Boundary continuity + biome distribution + heightmap-stats tests for
 * `shared/galaxy/surface`. Extracted from `surface.test.ts` to keep
 * each test file under the 300-line ceiling from AGENTS.md.
 *
 * Sibling files:
 *   - `surface.test.ts` — shape, resource-node, landing-pad, and
 *                        determinism tests.
 *   - `surface.parity.test.ts` — golden snapshot + source purity.
 */

import { describe, it, expect } from "vitest";

import { generateSurfaceChunk } from "./surface.js";
import type { Planet, Star } from "./types.js";
import { generateStars } from "./stars.js";
import { generateSystemFromStar } from "./system.js";
import { CHUNK_SIZE_CELLS, PEAK_HEIGHT_M } from "./config-surface.js";
import {
  computeHeightmapStats,
  generateFixtureChunk,
  sampleLandablePlanet,
} from "./surface.helpers.js";
import { DEV_SEED } from "./surface.helpers.js";

/** Returns the dev seed's first planet (orbit 0 — rocky, landable). */
function sampleFirstPlanet(): Planet {
  const stars = generateStars(DEV_SEED);
  const star = stars[0] as Star;
  const sys = generateSystemFromStar(DEV_SEED, star);
  return sys.planets[0] as Planet;
}

/** Returns the *first* landable planet — used for tests that need a guaranteed-pad chunk. */
function sampleLandableDevPlanet(): Planet {
  return sampleLandablePlanet();
}

// ---------------------------------------------------------------------------
// Boundary continuity
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — boundary continuity", () => {
  it("adjacent chunks (0,0) and (1,0) share a small delta at their shared column", () => {
    // The "shared column" between chunks (0,0) and (1,0) is the right edge
    // of (0,0) (worldX=63) and the left edge of (1,0) (worldX=64). Because
    // we sample fBm in world space using a planet-scoped `terrainSeed`
    // (constant across chunks of the same planet), both samples come from
    // the same noise field — they should agree to within the noise
    // gradient at that point.
    //
    // Empirically, with 3 octaves at gain=0.5 and 64 m base lattice
    // spacing (so octaves live at 64 m / 32 m / 16 m), max delta across
    // the entire border is ≤ 5 m and median delta ≤ 2 m on the dev seed
    // and three other reference seeds (see the perf script in
    // `/tmp/check_deltas.ts`). We assert max ≤ 25 m and median ≤ 10 m
    // — generous safety margins that would catch a regression (e.g.
    // switching `generateHeightmap` to use the per-chunk `placementSeed`
    // instead of the planet-scoped `terrainSeed`, which would push the
    // deltas into the hundreds of metres).
    const planet = sampleFirstPlanet();
    const a = generateSurfaceChunk(DEV_SEED, planet, 0, 0);
    const b = generateSurfaceChunk(DEV_SEED, planet, 1, 0);

    const aRight: number[] = [];
    const bLeft: number[] = [];
    for (let j = 0; j < CHUNK_SIZE_CELLS; j++) {
      aRight.push(a.heightmap[j * CHUNK_SIZE_CELLS + (CHUNK_SIZE_CELLS - 1)] as number);
      bLeft.push(b.heightmap[j * CHUNK_SIZE_CELLS + 0] as number);
    }

    const deltas = aRight.map((ah, i) => Math.abs(ah - (bLeft[i] as number)));
    const maxDelta = Math.max(...deltas);
    const sorted = [...deltas].sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)] as number;

    expect(maxDelta).toBeLessThanOrEqual(25);
    expect(median).toBeLessThanOrEqual(10);

    // Sanity: heights themselves are valid (just guards against an
    // accidental swap of width/height in the row-major indexing).
    for (const h of aRight) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(PEAK_HEIGHT_M);
    }
  });

  it("adjacent chunks (0,0) and (0,1) share a small delta at their shared row", () => {
    const planet = sampleFirstPlanet();
    const a = generateSurfaceChunk(DEV_SEED, planet, 0, 0);
    const b = generateSurfaceChunk(DEV_SEED, planet, 0, 1);

    const aBottom: number[] = [];
    const bTop: number[] = [];
    const lastRow = (CHUNK_SIZE_CELLS - 1) * CHUNK_SIZE_CELLS;
    for (let i = 0; i < CHUNK_SIZE_CELLS; i++) {
      aBottom.push(a.heightmap[lastRow + i] as number);
      bTop.push(b.heightmap[i] as number);
    }

    const deltas = aBottom.map((ah, i) => Math.abs(ah - (bTop[i] as number)));
    const maxDelta = Math.max(...deltas);
    expect(maxDelta).toBeLessThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// Biome distribution (sanity)
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — biome distribution", () => {
  it("produces at least 2 distinct biomes across 100 chunks of a landable planet", () => {
    const planet = sampleFirstPlanet();
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const cx = i % 10;
      const cz = Math.floor(i / 10);
      const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
      seen.add(chunk.biome);
    }
    // With 5 biomes and a landable planet, we should see at least 2 (likely 3+).
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Internal sanity: stats agree with the heightmap contents
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — heightmap stats", () => {
  it("computeHeightmapStats agrees with the actual heightmap contents", () => {
    const chunk = generateFixtureChunk();
    const stats = computeHeightmapStats(chunk.heightmap);
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const h of chunk.heightmap) {
      sum += h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    expect(stats.avg).toBeCloseTo(sum / chunk.heightmap.length, 10);
    expect(stats.min).toBe(min);
    expect(stats.max).toBe(max);
    expect(stats.gradient).toBe(max - min);
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — id derivation", () => {
  it("node ids are stable across calls (same (seed, planet, chunkX, chunkZ, nodeIndex))", () => {
    const planet = sampleLandableDevPlanet();
    const a = generateSurfaceChunk(DEV_SEED, planet, 2, 1);
    const b = generateSurfaceChunk(DEV_SEED, planet, 2, 1);
    expect(a.resourceNodes.map((n) => n.nodeId)).toEqual(b.resourceNodes.map((n) => n.nodeId));
  });
});
