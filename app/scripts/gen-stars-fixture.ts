/**
 * One-off script: regenerate `__fixtures__/stars-dev-seed.json` from
 * the current generator. Run with `npx tsx scripts/gen-stars-fixture.ts`
 * when the generator changes *and* you have updated the snapshot test.
 *
 * Not part of `npm run test`. Not committed to a CI path; called only
 * during development. The script intentionally writes the file even
 * if it already exists — that is its purpose.
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
  first25: stars.slice(0, 25),
};

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../src/shared/galaxy/__fixtures__/stars-dev-seed.json");
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.info(
  `Wrote ${stars.length} stars (first 25 in fixture) → ${out}\nChecksum: ${fixture.checksum}`,
);
