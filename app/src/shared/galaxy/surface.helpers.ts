/**
 * Shared helpers for the `shared/galaxy/surface` test suite.
 *
 * Mirrors `system.helpers.ts`: keeps DEV_SEED, fixture loader, and
 * common sampling helpers in one (non-test) module so the suite files
 * can stay small and the `noUnusedLocals` strict-TS rule is happy.
 *
 * The committed golden fixture pins down the exact `SurfaceChunk` for
 * `(seed = "drift-dev-seed-001", planet = star #0's first landable
 * planet, chunkX = 0, chunkZ = 0)`. Both the heightmap (sampled at a
 * 4×4 grid of 16 points) and the full resource-node + landing-pad
 * arrays are compared — see `surface.parity.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { generateStars } from "./stars.js";
import { generateSystemFromStar } from "./system.js";
import type { Planet, Star } from "./types.js";
import { generateSurfaceChunk, type SurfaceChunk } from "./surface.js";
import { CELLS_PER_CHUNK, CHUNK_SIZE_CELLS } from "./config-surface.js";

/** Canonical drift dev seed (matches every other fixture). */
export const DEV_SEED = "drift-dev-seed-001";

/** Star index #0 of the dev-seed galaxy — the fixture's parent star. */
export const STAR_INDEX = 0;

/** Chunk coordinates the fixture targets. */
export const FIXTURE_CHUNK_X = 0;
export const FIXTURE_CHUNK_Z = 0;

/**
 * Returns the dev seed's first landable planet (the fixture's parent).
 *
 * The galaxy's star #0 (`Ilmamnya`) has 4 planets in
 * `system-dev-seed-star0.json` — three landable terran/rocky/terran
 * worlds plus an ice world. We pick the **first** landable planet so
 * the fixture is reproducible regardless of how the test runner orders
 * the planets.
 */
export function sampleLandablePlanet(): Planet {
  const stars = generateStars(DEV_SEED);
  const star = stars[STAR_INDEX] as Star;
  const system = generateSystemFromStar(DEV_SEED, star);
  const landable = system.planets.find((p) => p.landable);
  if (!landable) {
    throw new Error("surface.helpers: star #0 has no landable planet (fixture pre-condition)");
  }
  return landable;
}

/**
 * Shape of the committed fixture:
 *
 *   {
 *     "seed":  "drift-dev-seed-001",
 *     "star":  { "id": "...", "name": "...", ... },
 *     "planet": { "id": "...", "name": "...", ... },
 *     "chunkX": 0,
 *     "chunkZ": 0,
 *     "heightmap16": [ ...16 sampled metres... ],
 *     "heightmapStats": { "avg": ..., "min": ..., "max": ..., "gradient": ... },
 *     "biome": "plains",
 *     "resourceNodes": [ ... ],
 *     "landingPads": [ ... ]
 *   }
 *
 * `heightmap16` is the canonicalised heightmap: 4×4 grid (every 16th
 * cell) of metres, row-major. `heightmapStats` lets the parity test
 * assert the global stats without shipping the full 4096-cell
 * heightmap in the fixture.
 */
export interface SurfaceFixture {
  seed: string;
  star: { id: string; name: string };
  planet: {
    id: string;
    name: string;
    orbitIndex: number;
    class: string;
    radiusKm: number;
    hasAtmosphere: boolean;
    landable: boolean;
    resourceTypes: readonly string[];
  };
  chunkX: number;
  chunkZ: number;
  heightmap16: readonly number[];
  heightmapStats: { avg: number; min: number; max: number; gradient: number };
  biome: string;
  resourceNodes: readonly {
    nodeId: string;
    type: string;
    x: number;
    z: number;
    baseQuantity: number;
  }[];
  landingPads: readonly { id: string; x: number; z: number }[];
}

/** Loads the committed golden fixture. */
export function loadSurfaceFixture(): SurfaceFixture {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "__fixtures__/surface-dev-seed-star0-planet0-chunk00.json");
  return JSON.parse(readFileSync(path, "utf8")) as SurfaceFixture;
}

/**
 * Returns a deterministic 4×4 sample (16 metres) of a chunk's heightmap
 * — every 16th cell, row-major. Used to build the golden fixture and
 * to assert regeneration in the parity test.
 */
export function sampleHeightmap16(heightmap: readonly number[]): number[] {
  if (heightmap.length !== CELLS_PER_CHUNK) {
    throw new Error(
      `sampleHeightmap16: heightmap length ${heightmap.length} != ${CELLS_PER_CHUNK}`,
    );
  }
  const step = CHUNK_SIZE_CELLS / 4; // 16
  const out: number[] = [];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      out.push(heightmap[j * step * CHUNK_SIZE_CELLS + i * step] as number);
    }
  }
  return out;
}

/** Average, min, and max of a heightmap — for the golden fixture. */
export function computeHeightmapStats(heightmap: readonly number[]): {
  avg: number;
  min: number;
  max: number;
  gradient: number;
} {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heightmap.length; i++) {
    const h = heightmap[i] as number;
    sum += h;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { avg: sum / heightmap.length, min, max, gradient: max - min };
}

/**
 * Convenience: regenerates the fixture's parent chunk and returns both
 * the full chunk and the 16-sampled heightmap. Tests use this as a
 * starting point for deep-equality checks.
 */
export function generateFixtureChunk(): SurfaceChunk {
  return generateSurfaceChunk(DEV_SEED, sampleLandablePlanet(), FIXTURE_CHUNK_X, FIXTURE_CHUNK_Z);
}
