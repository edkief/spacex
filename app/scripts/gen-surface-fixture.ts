/**
 * One-off script: regenerate
 * `app/src/shared/galaxy/__fixtures__/surface-dev-seed-star0-planet0-chunk00.json`
 * from the current generator.
 *
 * Run with `npx tsx scripts/gen-surface-fixture.ts` whenever the
 * surface generator changes *and* the snapshot test has been updated to
 * match the new expected output. Mirrors `gen-system-fixture.ts` and
 * `gen-stars-fixture.ts`.
 *
 * The committed fixture pins down:
 *
 *   - the 4×4 heightmap sample (16 metres) — enough to catch a fBm or
 *     heightmap pass change without bloating the fixture with 4096
 *     entries;
 *   - the full biome / resourceNodes / landingPads output;
 *   - per-heightmap stats (avg, min, max, gradient).
 *
 * Together these are a strong fingerprint: changing any tunables in
 * `config-surface.ts` (fBm gain, lattice spacing, biome thresholds,
 * peak height, etc.) will invalidate the fixture.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateStars } from "../src/shared/galaxy/stars.js";
import { generateSystemFromStar } from "../src/shared/galaxy/system.js";
import { generateSurfaceChunk } from "../src/shared/galaxy/surface.js";
import type { Star } from "../src/shared/galaxy/types.js";
import {
  computeHeightmapStats,
  sampleHeightmap16,
  sampleLandablePlanet,
} from "../src/shared/galaxy/surface.helpers.js";

const DEV_SEED = "drift-dev-seed-001";
const STAR_INDEX = 0;
const CHUNK_X = 0;
const CHUNK_Z = 0;

const stars = generateStars(DEV_SEED);
const star = stars[STAR_INDEX] as Star;
if (!star) throw new Error(`Star ${STAR_INDEX} missing from galaxy`);

// Validate the parent star's first landable planet matches the
// expected fixture scenario (used by `surface.helpers.sampleLandablePlanet`).
const system = generateSystemFromStar(DEV_SEED, star);
const landable = system.planets.find((p) => p.landable);
if (!landable)
  throw new Error(`Star ${star.name} has no landable planet — fixture pre-condition broken`);

const samplePlanet = sampleLandablePlanet();
const chunk = generateSurfaceChunk(DEV_SEED, samplePlanet, CHUNK_X, CHUNK_Z);

const fixture = {
  seed: DEV_SEED,
  star: { id: star.id, name: star.name },
  planet: {
    id: samplePlanet.id,
    name: samplePlanet.name,
    orbitIndex: samplePlanet.orbitIndex,
    class: samplePlanet.class,
    radiusKm: samplePlanet.radiusKm,
    hasAtmosphere: samplePlanet.hasAtmosphere,
    landable: samplePlanet.landable,
    resourceTypes: samplePlanet.resourceTypes,
  },
  chunkX: chunk.chunkX,
  chunkZ: chunk.chunkZ,
  // Sampled fields — kept for back-compat with the parity test
  // (`surface.parity.test.ts`) which uses `heightmap16` + stats as a
  // lightweight fingerprint. The TASK-6 snapshot suite uses the full
  // `heightmap` below for deep-equal.
  heightmap16: sampleHeightmap16(chunk.heightmap),
  heightmapStats: computeHeightmapStats(chunk.heightmap),
  // Full 4096-cell heightmap — supports the TASK-6 deep-equal snapshot.
  heightmap: chunk.heightmap,
  biome: chunk.biome,
  resourceNodes: chunk.resourceNodes,
  landingPads: chunk.landingPads,
};

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(
  here,
  "../src/shared/galaxy/__fixtures__/surface-dev-seed-star0-planet0-chunk00.json",
);
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.info(
  `Wrote surface chunk (${CHUNK_X}, ${CHUNK_Z}) of ${star.name}'s first landable planet (${samplePlanet.name}, id=${samplePlanet.id}) — biome=${chunk.biome}, ${chunk.resourceNodes.length} nodes, ${chunk.landingPads.length} pads → ${out}`,
);
