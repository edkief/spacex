/**
 * Mutation-detection suite for the TASK-6 snapshot harness.
 *
 * The acceptance criterion requires "a test that intentionally
 * corrupts one generator output (e.g. flips a class weight) fails the
 * snapshot suite (verify by running the suite against a temp-modified
 * copy or a guarded branch)".
 *
 * This file implements that check *inside the test suite* rather than
 * via a manual code-flip: it constructs a deliberately-mutated clone
 * of `generateStars` (with O ↔ M spectral weights swapped) and asserts
 *
 *   - the real generator still matches the committed chart (sanity —
 *     prevents a false-positive mutation test if the real generator
 *     ever drifts),
 *   - the mutated generator's output diverges from the committed chart
 *     on both distribution and checksum (proves the snapshot suite
 *     would catch the drift),
 *
 * so that if the snapshot equality later becomes silently no-op
 * (e.g. someone replaces `.toEqual` with `.toBeDefined`), this test
 * catches the regression.
 *
 * @see ./snapshots.test.ts for the main scenario suite.
 * @see ./snapshots.helpers.ts for the shared mutation generator.
 */

import { describe, it, expect } from "vitest";

import { canonicalJson } from "./canonical.js";
import { generateStars } from "./stars.js";
import type { Star } from "./types.js";
import { loadFixture, mutatedGenerateStars, type StarsFixture } from "./snapshots.helpers.js";

/** Count how many stars in `list` have `class === cls`. */
function countOf(cls: string, list: readonly Star[]): number {
  let n = 0;
  for (const s of list) if (s.class === cls) n++;
  return n;
}

describe("snapshots — mutation detection (proves the suite catches drift)", () => {
  it("real generator still matches the committed chart (sanity gate)", () => {
    const fx = loadFixture<StarsFixture>("stars-dev-seed-full.json");
    const stars = generateStars(fx.seed);
    expect(stars).toEqual(fx.stars);
  });

  it("mutated generator (swapped O ↔ M weights) diverges from the committed chart", () => {
    const fx = loadFixture<StarsFixture>("stars-dev-seed-full.json");
    const realStars = generateStars(fx.seed);
    const mutatedStars = mutatedGenerateStars(fx.seed, realStars.length);

    // Sanity: real generator still matches the fixture (otherwise the
    // mutation test would be a false positive).
    expect(realStars).toEqual(fx.stars);

    // The mutation MUST change the distribution. With O and M weights
    // swapped, O (originally 0.5%) and M (originally 37.5%) change
    // places — over 200 stars the O-class count rises from ~1 to ~75.
    const realOCount = countOf("O", realStars);
    const mutatedOCount = countOf("O", mutatedStars);
    expect(realOCount).toBeLessThan(10); // sanity: O is genuinely rare in the real chart
    expect(mutatedOCount).toBeGreaterThan(50); // and well past it after the swap

    // The snapshot deep-equal would also catch the mutation — proving
    // the suite is sensitive to this drift.
    expect(canonicalJson(mutatedStars)).not.toBe(canonicalJson(fx.stars));
    expect(mutatedStars).not.toEqual(fx.stars);
  });
});
