/**
 * One-off script: regenerate
 * `app/src/shared/galaxy/__fixtures__/system-dev-seed-star1.json`
 * from the current system generator. Run with
 * `npx tsx scripts/gen-system-star1-fixture.ts` whenever the generator
 * changes *and* the snapshot test has been updated to match.
 *
 * Mirrors `gen-system-fixture.ts` (TASK-4). The committed fixture pins
 * down the exact `SystemGen` for star #1 of `drift-dev-seed-001`,
 * covering all twelve Planet fields plus the SystemGen envelope
 * (systemId, name, star snapshot, planets array).
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateStars } from "../src/shared/galaxy/stars.js";
import { generateSystemFromStar } from "../src/shared/galaxy/system.js";

const DEV_SEED = "drift-dev-seed-001";
const STAR_INDEX = 1;

const stars = generateStars(DEV_SEED);
const star = stars[STAR_INDEX];
if (!star) throw new Error(`Star ${STAR_INDEX} missing from galaxy`);

const system = generateSystemFromStar(DEV_SEED, star);

const fixture = {
  seed: DEV_SEED,
  starIndex: STAR_INDEX,
  starId: star.id,
  system,
};

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../src/shared/galaxy/__fixtures__/system-dev-seed-star1.json");
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.info(
  `Wrote system for ${star.name} (${star.id}) — ${system.planets.length} planets → ${out}`,
);
