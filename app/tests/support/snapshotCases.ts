import { canonicalJson } from '@shared/canonical.ts';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSurfaceChunk } from '@shared/galaxy/surface.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
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
function surfaceFixture(chunkX: number, chunkZ: number): unknown {
  const { planet } = firstPlanet(SNAPSHOT_SEED, (candidate) => candidate.landable);
  const chunk = generateSurfaceChunk(SNAPSHOT_SEED, planet, chunkX, chunkZ);
  return { seed: SNAPSHOT_SEED, planetId: planet.id, chunk: chunkFixtureBody(chunk) };
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
  ];
}
