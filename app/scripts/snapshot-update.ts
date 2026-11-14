import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_DIR, PHYSICS_FIXTURE_DIR, serializeFixture } from '../tests/support/fixtures.ts';
import { physicsCases } from '../tests/support/trajectories.ts';
import { snapshotCases } from '../tests/support/snapshotCases.ts';

// Deliberate regeneration of the determinism fixtures. Only run after an approved generator
// change; the normal test suite compares and never writes.
mkdirSync(FIXTURE_DIR, { recursive: true });
for (const { file, build } of snapshotCases()) {
  writeFileSync(path.join(FIXTURE_DIR, file), serializeFixture(build()));
  console.log(`wrote ${file}`);
}

mkdirSync(PHYSICS_FIXTURE_DIR, { recursive: true });
for (const { file, build } of physicsCases()) {
  writeFileSync(path.join(PHYSICS_FIXTURE_DIR, file), serializeFixture(build()));
  console.log(`wrote physics/${file}`);
}
