/**
 * One-off script: regenerate
 * `app/src/shared/galaxy/__fixtures__/surface-dev-seed-star0-planet0-chunk10.json`
 * from the current surface generator.
 *
 * Run with `npx tsx scripts/gen-surface-chunk10-fixture.ts` whenever
 * the surface generator changes *and* the snapshot test has been
 * updated to match. Mirrors `gen-surface-fixture.ts` (TASK-5) and the
 * other chunk-NxM scripts.
 *
 * The committed fixture pins down the full `SurfaceChunk` (including
 * the 4096-cell heightmap, biome, resource nodes, and landing pads)
 * for `(seed = "drift-dev-seed-001", planet = star #0's first
 * landable planet, chunkX = 1, chunkZ = 0)`.
 *
 * We write the full SurfaceChunk — no sampling — so the snapshot test
 * can deep-equal the regenerated object against the fixture.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateStars } from "../src/shared/galaxy/stars.js";
import { generateSystemFromStar } from "../src/shared/galaxy/system.js";
import { generateSurfaceChunk } from "../src/shared/galaxy/surface.js";
import type { Star } from "../src/shared/galaxy/types.js";
import { sampleLandablePlanet } from "../src/shared/galaxy/surface.helpers.js";

const DEV_SEED = "drift-dev-seed-001";
const STAR_INDEX = 0;
const CHUNK_X = 1;
const CHUNK_Z = 0;

const stars = generateStars(DEV_SEED);
const star = stars[STAR_INDEX] as Star;
if (!star) throw new Error(`Star ${STAR_INDEX} missing from galaxy`);

// Sanity: the planet must match the dev seed's first landable.
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
  heightmap: chunk.heightmap,
  biome: chunk.biome,
  resourceNodes: chunk.resourceNodes,
  landingPads: chunk.landingPads,
};

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(
  here,
  "../src/shared/galaxy/__fixtures__/surface-dev-seed-star0-planet0-chunk10.json",
);
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.info(
  `Wrote surface chunk (${CHUNK_X}, ${CHUNK_Z}) of ${star.name}'s first landable planet (${samplePlanet.name}, id=${samplePlanet.id}) — biome=${chunk.biome}, ${chunk.resourceNodes.length} nodes, ${chunk.landingPads.length} pads → ${out}`,
);
