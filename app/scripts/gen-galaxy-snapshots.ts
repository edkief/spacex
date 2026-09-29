/**
 * Regenerates the TASK-6 galaxy determinism snapshot fixtures in
 * app/src/shared/galaxy/__fixtures__/ (files prefixed `snapshot-`).
 *
 * Fixtures:
 *   snapshot-stars-dev-seed.json   full star chart (dev seed, 200 stars)
 *   snapshot-system-star0.json     system of star #0
 *   snapshot-system-star1.json     system of star #1
 *   snapshot-chunk-{0,1}-{0,1}.json  chunks (0,0) (1,0) (0,1) of the first
 *                                    landable planet of star #0's system
 *
 * Each fixture wraps the raw generated value: { seed, starId?, value }.
 * Files are written as pretty-printed canonical JSON (sorted keys) so they
 * are platform-stable. Run with: npm run snapshot:update
 *
 * The default test (src/shared/galaxy/snapshots.test.ts) ONLY compares —
 * it never writes. Regenerate only after an approved generator change.
 *
 * File formatting is cosmetic (tests compare canonical JSON), but the script
 * runs prettier over the written files at the end so output passes `npm run lint`.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../src/shared/canonical.js';
import { generateStars } from '../src/shared/galaxy/stars.js';
import { generateSystem } from '../src/shared/galaxy/system.js';
import { generateSurfaceChunk } from '../src/shared/galaxy/surface.js';
import type { Star, SystemGen, SurfaceChunk } from '../src/shared/galaxy/types.js';

const SEED = 'drift-dev-seed-001';
const FIXTURES = path.resolve(import.meta.dirname, '../src/shared/galaxy/__fixtures__');

interface Fixture {
  seed: string;
  starId?: string;
  planetId?: string;
  chunkX?: number;
  chunkZ?: number;
  value: unknown;
}

/** Write `fixture` to `name` as pretty-printed canonical JSON (sorted keys). */
function writeFixture(name: string, fixture: Fixture): void {
  const canonical = JSON.parse(canonicalJson(fixture)) as unknown;
  writeFileSync(path.join(FIXTURES, name), JSON.stringify(canonical, null, 2) + '\n');
  console.log(`wrote ${name}`);
}

const stars: Star[] = generateStars(SEED);
const star0 = stars[0];
const star1 = stars[1];

writeFixture('snapshot-stars-dev-seed.json', { seed: SEED, value: stars });

const system0: SystemGen = generateSystem(SEED, star0.id);
const system1: SystemGen = generateSystem(SEED, star1.id);
writeFixture('snapshot-system-star0.json', {
  seed: SEED,
  starId: star0.id,
  value: system0,
});
writeFixture('snapshot-system-star1.json', {
  seed: SEED,
  starId: star1.id,
  value: system1,
});

const planetIndex = system0.planets.findIndex((p) => p.landable);
if (planetIndex === -1) throw new Error('no landable planet in star #0 (unexpected)');
const planet = system0.planets[planetIndex];
for (const [cx, cz] of [
  [0, 0],
  [1, 0],
  [0, 1],
] as const) {
  const chunk: SurfaceChunk = generateSurfaceChunk(SEED, planet, cx, cz);
  writeFixture(`snapshot-chunk-${cx}-${cz}.json`, {
    seed: SEED,
    starId: star0.id,
    planetId: planet.id,
    chunkX: cx,
    chunkZ: cz,
    value: chunk,
  });
}
// Cosmetic pass: normalize formatting so committed files pass `npm run lint`.
execFileSync('npx', ['prettier', '--write', 'src/shared/galaxy/__fixtures__/snapshot-*.json'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
});

console.log(
  `done (star #0 id ${star0.id}, star #1 id ${star1.id}, first landable planet #${planetIndex} "${planet.name}")`,
);
