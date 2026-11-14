import { canonicalJson } from '@shared/canonical.ts';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSurfaceChunk } from '@shared/galaxy/surface.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import type { Hemisphere } from '@shared/galaxy/chart.ts';
import type { SurfaceChunk } from '@shared/galaxy/types.ts';
import { sha256Hex } from './checksum.ts';
import { firstPlanet } from './galaxy.ts';

export const SNAPSHOT_SEED = 'drift-dev-seed-001';

/** A committed fixture: its file name and a builder that regenerates the value from the code. */
export interface SnapshotCase {
  file: string;
  build: () => unknown;
}

/** Full star chart plus count and sha256 of its compact canonical JSON. */
function starChart(): unknown {
  const stars = generateStars(SNAPSHOT_SEED);
  return {
    seed: SNAPSHOT_SEED,
    count: stars.length,
    checksum: sha256Hex(canonicalJson(stars)),
    stars,
  };
}

/** System fixture for the star at `index` of the dev-seed chart. */
function systemFixture(index: number): unknown {
  const star = generateStars(SNAPSHOT_SEED)[index];
  if (!star) throw new Error(`no star #${index}`);
  return {
    seed: SNAPSHOT_SEED,
    starId: star.id,
    system: generateSystemForStar(SNAPSHOT_SEED, star),
  };
}

const SAMPLE_GRID = [0, 21, 42, 63];

/**
 * Chunk fixture: everything verbatim except the 4096-value heightmap, which is recorded as its
 * length, a sha256 of its canonical JSON, and 16 sampled (i, j, value) points for readable diffs.
 */
export function chunkFixtureBody(chunk: SurfaceChunk): unknown {
  const samples = SAMPLE_GRID.flatMap((j) =>
    SAMPLE_GRID.map((i) => ({ i, j, value: chunk.heightmap[j * 64 + i] })),
  );
  return {
    ...chunk,
    heightmap: {
      length: chunk.heightmap.length,
      sha256: sha256Hex(canonicalJson(chunk.heightmap)),
      samples,
    },
  };
}

/** Surface fixture for chunk (cx, cz) of the dev-seed landable planet. */
function surfaceFixture(chunkX: number, chunkZ: number, hemisphere: Hemisphere = 'n'): unknown {
  const { planet } = firstPlanet(SNAPSHOT_SEED, (candidate) => candidate.landable);
  const chunk = generateSurfaceChunk(SNAPSHOT_SEED, planet, chunkX, chunkZ, hemisphere);
  return { seed: SNAPSHOT_SEED, planetId: planet.id, chunk: chunkFixtureBody(chunk) };
}

const DIGEST_CHUNK_RANGE = [-4, -3, -2, -1, 0, 1, 2, 3];

/**
 * Broad-coverage digests: sha256 over every system of the chart, and over chunk grids in both
 * charts (pole and near-equator) for the first landable planet of each class. Catches small probability or constant changes that
 * the few fully recorded fixtures would not happen to exercise.
 */
function galaxyDigests(): unknown {
  const stars = generateStars(SNAPSHOT_SEED);
  const systems = stars.map((star) => generateSystemForStar(SNAPSHOT_SEED, star));
  const classes = ['terran', 'rocky', 'ocean', 'ice'] as const;
  const surfaces = classes.map((planetClass) => {
    const { planet } = firstPlanet(SNAPSHOT_SEED, (p) => p.landable && p.class === planetClass);
    // Both charts: an 8x8 grid at each pole, plus 8 chunks near the equator of each chart.
    const nearEquator = Math.floor((2 * planet.simRadius) / 256) - 2;
    const chunks = (['n', 's'] as const).flatMap((hemisphere) => [
      ...DIGEST_CHUNK_RANGE.flatMap((cz) =>
        DIGEST_CHUNK_RANGE.map((cx) =>
          generateSurfaceChunk(SNAPSHOT_SEED, planet, cx, cz, hemisphere),
        ),
      ),
      ...DIGEST_CHUNK_RANGE.map((cz) =>
        generateSurfaceChunk(SNAPSHOT_SEED, planet, nearEquator, cz, hemisphere),
      ),
    ]);
    return {
      class: planetClass,
      planetId: planet.id,
      chunkCount: chunks.length,
      sha256: sha256Hex(canonicalJson(chunks)),
    };
  });
  return {
    seed: SNAPSHOT_SEED,
    systems: { count: systems.length, sha256: sha256Hex(canonicalJson(systems)) },
    surfaces,
  };
}

/** Every committed snapshot fixture, shared by the comparison tests and `snapshot:update`. */
export function snapshotCases(): SnapshotCase[] {
  return [
    { file: 'stars-dev-seed.json', build: starChart },
    { file: 'system-star-0.json', build: () => systemFixture(0) },
    { file: 'system-star-1.json', build: () => systemFixture(1) },
    { file: 'surface-0-0.json', build: () => surfaceFixture(0, 0) },
    { file: 'surface-1-0.json', build: () => surfaceFixture(1, 0) },
    { file: 'surface-0-1.json', build: () => surfaceFixture(0, 1) },
    { file: 'surface-south-0-0.json', build: () => surfaceFixture(0, 0, 's') },
    { file: 'galaxy-digests.json', build: galaxyDigests },
  ];
}
