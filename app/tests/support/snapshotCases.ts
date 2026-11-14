import { canonicalJson } from '@shared/canonical.ts';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { sha256Hex } from './checksum.ts';

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

/** Every committed snapshot fixture, shared by the comparison tests and `snapshot:update`. */
export function snapshotCases(): SnapshotCase[] {
  return [
    { file: 'stars-dev-seed.json', build: starChart },
    { file: 'system-star-0.json', build: () => systemFixture(0) },
    { file: 'system-star-1.json', build: () => systemFixture(1) },
  ];
}
