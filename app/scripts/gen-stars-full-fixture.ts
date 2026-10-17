/**
 * One-off script: regenerate
 * `app/src/shared/galaxy/__fixtures__/stars-dev-seed-full.json`
 * from the current star generator.
 *
 * Mirrors `gen-stars-fixture.ts` (TASK-3) but writes the **full** 200-star
 * chart instead of just the first 25. Used by the TASK-6 snapshot suite
 * (`snapshots.test.ts`) to deep-equal the entire galaxy against the
 * committed fixture.
 *
 * Run with `npx tsx scripts/gen-stars-full-fixture.ts` whenever the
 * star generator changes *and* the snapshot test has been updated to
 * match the new expected output. The default test run never writes —
 * only this deliberate command does.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateStars } from "../src/shared/galaxy/stars.js";
import { starListChecksum } from "../src/shared/galaxy/canonical.js";
import { GALAXY_STAR_COUNT } from "../src/shared/galaxy/config.js";

const DEV_SEED = "drift-dev-seed-001";

const stars = generateStars(DEV_SEED, GALAXY_STAR_COUNT);

const fixture = {
  seed: DEV_SEED,
  count: stars.length,
  checksum: starListChecksum(stars),
  stars,
};

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../src/shared/galaxy/__fixtures__/stars-dev-seed-full.json");
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.info(`Wrote ${stars.length} stars (full chart) → ${out}\nChecksum: ${fixture.checksum}`);
