/**
 * Regenerates the TASK-5 golden fixture:
 *   app/src/shared/galaxy/__fixtures__/surface-dev-seed-chunk00.json
 *
 * Chunk (0,0) of the first landable planet of star #0 under the dev seed.
 * Run with: npx tsx scripts/gen-surface-fixture.ts
 * (surface.test.ts fails loudly if the generated output ever diverges.)
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../src/shared/canonical.js';
import { generateSystem } from '../src/shared/galaxy/system.js';
import { generateSurfaceChunk, HEIGHTMAP_SAMPLE_CELLS } from '../src/shared/galaxy/surface.js';

const SEED = 'drift-dev-seed-001';
const STAR_ID = '7dc36749a54c15d8'; // star #0 of the dev seed (see system fixture)

const system = generateSystem(SEED, STAR_ID);
const planetIndex = system.planets.findIndex((p) => p.landable);
if (planetIndex === -1) throw new Error('no landable planet in star #0 (unexpected)');
const planet = system.planets[planetIndex];
const chunk = generateSurfaceChunk(SEED, planet, 0, 0);

const fixture = {
  seed: SEED,
  starId: STAR_ID,
  planetIndex,
  planetId: planet.id,
  planetClass: planet.class,
  chunkX: 0,
  chunkZ: 0,
  biome: chunk.biome,
  heightmapSamples: HEIGHTMAP_SAMPLE_CELLS.map(([x, z]) => chunk.heightmap[z * 64 + x]),
  resourceNodes: chunk.resourceNodes,
  landingPads: chunk.landingPads,
  fullChecksum: createHash('sha256').update(canonicalJson(chunk)).digest('hex'),
};

const out = path.resolve(
  import.meta.dirname,
  '../src/shared/galaxy/__fixtures__/surface-dev-seed-chunk00.json',
);
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log(
  `wrote ${path.relative(process.cwd(), out)} (planet #${planetIndex} "${planet.name}", ` +
    `${chunk.resourceNodes.length} nodes, ${chunk.landingPads.length} pads)`,
);
