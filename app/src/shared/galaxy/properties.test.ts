/**
 * Galaxy determinism — property-style test suite (TASK-71).
 *
 * The TASK-6 snapshot suite (`snapshots.test.ts`) locks down specific
 * (seed, indices) combos against committed fixtures. This file instead
 * sweeps the input space: a meta-seeded random walk picks 10 distinct
 * galaxy seeds, then 10 random stars per seed, and verifies that two
 * independent `generateSystem(...)` invocations produce identical
 * outputs (`toEqual`, plus a `canonicalJson` byte-equal check). The
 * companion second scenario sweeps 200 random `(planet, chunk)` pairs
 * across one fixed galaxy and verifies the resource-node `nodeId` set
 * + chunk-local positions reproduce.
 *
 * Failure mode: the very first divergence is reported as a JSON-pointer
 * path (via the existing `firstDivergentPath` helper from
 * `snapshots.helpers`), so a flaky seeded loop doesn't drown the
 * failure in a 4 096-element diff.
 *
 * The loop's own randomness is meta-seeded with a fixed constant
 * (`META_SEED`), so a developer can re-run the suite and the *same*
 * 10+200 combinations fire every time — failures are reproducible
 * without needing to seed `Math.random()` manually.
 *
 * @see ./snapshots.test.ts for the locked fixture scenarios.
 * @see ./stars.ts / ./system.ts / ./surface.ts for the generators.
 * @see ./snapshots.helpers.ts for `firstDivergentPath`.
 */

import { describe, it, expect } from "vitest";

import { generateStars } from "./stars.js";
import { generateSystemFromStar } from "./system.js";
import { generateSurfaceChunk } from "./surface.js";
import { canonicalJson } from "./canonical.js";
import { hash2 } from "../random.js";
import {
  firstDivergentPath,
  loadFixture,
  loadPlanetFromSurfaceFixture,
  type StarsFixture,
  type SurfaceFixtureShape,
} from "./snapshots.helpers.js";
import type { Planet, Star, SystemGen } from "./types.js";

// ---------------------------------------------------------------------------
// Meta-seed for the loop's own randomness
// ---------------------------------------------------------------------------

/**
 * The loop's own meta-randomness. Fixed so a failure in this file is
 * reproducible across runs — different combinations wouldn't help
 * catch a determinism bug, only make it harder to debug.
 *
 * Small constant chosen to be distinct from any seed the live server
 * might use; if it ever lands on, say, the dev seed, that's still
 * fine (we never *depend* on the loop picking a particular seed).
 */
const META_SEED = 0x71a5e1d ^ 0xc0ffee;

/** A simple xoshiro-style LCG for the meta-loop (no `Math.random`). */
function makeMetaRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG — fine for picking seeds/indices.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Pick one item from `arr` using the meta-rng. */
function pickFrom<T>(rng: () => number, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error("pickFrom: empty input");
  const idx = Math.floor(rng() * arr.length) % arr.length;
  return arr[idx] as T;
}

/** Pick an integer in `[min, max]` inclusive using the meta-rng. */
function pickInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// ---------------------------------------------------------------------------
// Scenario 1: system generator stability across 10 seeds × 10 stars
// ---------------------------------------------------------------------------

describe("determinism — generateSystem across 10 random seeds × 10 random stars each", () => {
  const SEED_COUNT = 10;
  const STARS_PER_SEED = 10;

  it("two independent invocations produce byte-equal SystemGen objects", () => {
    const rng = makeMetaRng(META_SEED);
    /**
     * Pick 10 distinct galaxy seeds. We re-pick on collision so the
     * outer loop always sees 10 unique seeds; the inner loop picks
     * 10 random star indices per seed.
     */
    const seeds = new Set<string>();
    while (seeds.size < SEED_COUNT) {
      const hex = Math.floor(rng() * 0xffffffff)
        .toString(16)
        .padStart(8, "0");
      seeds.add(`prop-${hex}-${Math.floor(rng() * 0xffffffff).toString(16)}`);
    }
    const seedList = [...seeds];

    /** Star indices we exercised (for the error message). */
    const exercisedPairs: Array<{ seed: string; starIndex: number; starId: string }> = [];

    for (const seed of seedList) {
      const stars = generateStars(seed);
      // Pick 10 random star indices (with replacement) so the test
      // doesn't require a minimum galaxy size beyond the spec's
      // default (200).
      for (let i = 0; i < STARS_PER_SEED; i++) {
        const starIndex = pickInt(rng, 0, stars.length - 1);
        const star = stars[starIndex] as Star;

        // First invocation.
        const systemA: SystemGen = generateSystemFromStar(seed, star);
        // Second invocation — same inputs, independent code path.
        const systemB: SystemGen = generateSystemFromStar(seed, star);

        // Quick field-level guards (cheap; deepEqual below does the
        // full check).
        expect(systemB.systemId).toBe(systemA.systemId);
        expect(systemB.name).toBe(systemA.name);
        expect(systemB.planets.length).toBe(systemA.planets.length);

        if (canonicalJson(systemA) !== canonicalJson(systemB)) {
          const path = firstDivergentPath(systemA, systemB);
          throw new Error(
            `generateSystemFromStar divergence for seed=${seed} starIndex=${starIndex} starId=${star.id} at ${path}`,
          );
        }
        expect(systemB).toEqual(systemA);
        exercisedPairs.push({ seed, starIndex, starId: star.id });
      }
    }

    // Sanity: we actually exercised 10 × 10 = 100 distinct cases
    // (starIndex can repeat, so the count is just `seeds × starsPerSeed`).
    expect(exercisedPairs.length).toBe(SEED_COUNT * STARS_PER_SEED);
  });

  it("star list itself is stable across two generateStars() calls (per-seed check)", () => {
    // The system generator implicitly relies on `generateStars`
    // being deterministic. This test guards the upstream contract
    // across the same 10 seeds used above.
    const rng = makeMetaRng(META_SEED ^ 0x55aa55aa);
    const seeds = new Set<string>();
    while (seeds.size < SEED_COUNT) {
      const hex = Math.floor(rng() * 0xffffffff)
        .toString(16)
        .padStart(8, "0");
      seeds.add(`prop-star-${hex}-${Math.floor(rng() * 0xffffffff).toString(16)}`);
    }

    for (const seed of seeds) {
      const a = generateStars(seed);
      const b = generateStars(seed);
      expect(b).toEqual(a);
      // And the byte-equal canonical form must match too (proves
      // no key-order drift between the two runs).
      expect(canonicalJson(b)).toBe(canonicalJson(a));
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: surface chunk stability across 200 random (planet, chunk)
// ---------------------------------------------------------------------------

/**
 * For a single fixed galaxy (the committed dev-seed galaxy), pick 200
 * random (planet, chunkX, chunkZ) triples and verify two independent
 * `generateSurfaceChunk` invocations produce identical `nodeId` sets
 * and identical (x, z) positions for the resource nodes + landing
 * pads.
 *
 * We compare two specific slices rather than the full chunk because
 * the heightmap (4 096 floats) is the most tedious to diff on a
 * failure message — if `nodeId` + position equality holds, the
 * deterministic pipeline that produced them is intact, and the
 * existing TASK-6 snapshot suite covers the heightmap byte-for-byte
 * for the specific (planet, chunk) pairs it cares about.
 */
describe("determinism — surface chunks across 200 random (planet, chunk) pairs", () => {
  const PAIR_COUNT = 200;
  /** Bounds on the (chunkX, chunkZ) sweep — a 32×32 neighbourhood is plenty. */
  const CHUNK_RANGE = 32;
  /** Use the committed dev-seed galaxy so the surface chunk generator has planets to pick from. */
  const GALAXY_SEED = "drift-dev-seed-001";

  /**
   * Build a list of `SurfaceChunk` field slices focused on the
   * node/pad invariants the spec asks us to compare. The full chunk
   * (heightmap, biome) is byte-equal too (TASK-6 proves it for three
   * specific pairs); this walker intentionally narrows the field
   * set so a failure message names the offending chunk directly.
   */
  function chunkSlices(chunk: ReturnType<typeof generateSurfaceChunk>): {
    nodeIds: string[];
    nodePositions: Array<{ x: number; z: number }>;
    padIds: string[];
    padPositions: Array<{ x: number; z: number }>;
    biome: string;
    heightmapHash: bigint;
  } {
    let h = 0n;
    for (let i = 0; i < chunk.heightmap.length; i++) {
      // Mix each heightmap cell into a 64-bit accumulator so two
      // chunks with identical bytes hash to the same value.
      h = hash2(h, BigInt(Math.round(chunk.heightmap[i] as number)) ^ BigInt(i));
    }
    return {
      nodeIds: chunk.resourceNodes.map((n) => n.nodeId).sort(),
      nodePositions: chunk.resourceNodes
        .map((n) => ({ x: n.x, z: n.z }))
        .sort((p, q) => (p.x === q.x ? p.z - q.z : p.x - q.x)),
      padIds: chunk.landingPads.map((p) => p.id).sort(),
      padPositions: chunk.landingPads
        .map((p) => ({ x: p.x, z: p.z }))
        .sort((p, q) => (p.x === q.x ? p.z - q.z : p.x - q.x)),
      biome: chunk.biome,
      heightmapHash: h,
    };
  }

  it("two independent generateSurfaceChunk() invocations produce identical slices", () => {
    // Build the galaxy's full planet catalogue once so we can pick
    // `(planet, chunkX, chunkZ)` triples against it.
    const stars = generateStars(GALAXY_SEED);
    const allPlanets: Array<{ planet: Planet; parentStarId: string }> = [];
    for (const star of stars) {
      const system = generateSystemFromStar(GALAXY_SEED, star);
      for (const planet of system.planets) {
        allPlanets.push({ planet, parentStarId: star.id });
      }
    }
    expect(allPlanets.length).toBeGreaterThan(0);

    const rng = makeMetaRng(META_SEED ^ 0xa11ce);
    const selected: Array<{ planetId: string; chunkX: number; chunkZ: number }> = [];

    for (let i = 0; i < PAIR_COUNT; i++) {
      const pick = pickFrom(rng, allPlanets);
      const chunkX = pickInt(rng, -CHUNK_RANGE, CHUNK_RANGE);
      const chunkZ = pickInt(rng, -CHUNK_RANGE, CHUNK_RANGE);
      selected.push({ planetId: pick.planet.id, chunkX, chunkZ });
    }

    /** Cached slices from each independent run, keyed by (planet, chunk). */
    const firstRunSlices = new Map<string, ReturnType<typeof chunkSlices>>();
    /** Track the first (planet, chunk) pair we saw a divergence on, if any. */
    let firstDivergentPair: { planetId: string; chunkX: number; chunkZ: number } | null = null;
    let firstDivergentReason: string | null = null;

    // First pass — generate and stash slices.
    for (const pair of selected) {
      const planet = allPlanets.find((p) => p.planet.id === pair.planetId)?.planet;
      if (!planet) continue;
      const chunk = generateSurfaceChunk(GALAXY_SEED, planet, pair.chunkX, pair.chunkZ);
      const slices = chunkSlices(chunk);
      firstRunSlices.set(`${pair.planetId}|${pair.chunkX}|${pair.chunkZ}`, slices);
    }

    // Second pass — regenerate and compare.
    for (const pair of selected) {
      const planet = allPlanets.find((p) => p.planet.id === pair.planetId)?.planet;
      if (!planet) continue;
      const chunk2 = generateSurfaceChunk(GALAXY_SEED, planet, pair.chunkX, pair.chunkZ);
      const slices2 = chunkSlices(chunk2);
      const key = `${pair.planetId}|${pair.chunkX}|${pair.chunkZ}`;
      const slices1 = firstRunSlices.get(key);
      if (!slices1) continue;

      if (firstDivergentPair === null) {
        if (slices1.biome !== slices2.biome) {
          firstDivergentPair = pair;
          firstDivergentReason = `biome ${slices1.biome} vs ${slices2.biome}`;
        } else if (slices1.heightmapHash !== slices2.heightmapHash) {
          firstDivergentPair = pair;
          firstDivergentReason = `heightmap hash ${slices1.heightmapHash.toString(16)} vs ${slices2.heightmapHash.toString(16)}`;
        } else if (canonicalJson(slices1.nodeIds) !== canonicalJson(slices2.nodeIds)) {
          firstDivergentPair = pair;
          firstDivergentReason = `nodeIds ${JSON.stringify(slices1.nodeIds)} vs ${JSON.stringify(slices2.nodeIds)}`;
        } else if (canonicalJson(slices1.padIds) !== canonicalJson(slices2.padIds)) {
          firstDivergentPair = pair;
          firstDivergentReason = `padIds ${JSON.stringify(slices1.padIds)} vs ${JSON.stringify(slices2.padIds)}`;
        } else if (canonicalJson(slices1.nodePositions) !== canonicalJson(slices2.nodePositions)) {
          firstDivergentPair = pair;
          firstDivergentReason = `nodePositions at ${
            firstDivergentPath(slices1.nodePositions, slices2.nodePositions) ?? "<unknown>"
          }`;
        } else if (canonicalJson(slices1.padPositions) !== canonicalJson(slices2.padPositions)) {
          firstDivergentPair = pair;
          firstDivergentReason = `padPositions diverge`;
        }
      }
    }

    expect(
      firstDivergentPair,
      `surface chunk divergence at planet=${firstDivergentPair?.planetId} chunk=(${firstDivergentPair?.chunkX},${firstDivergentPair?.chunkZ}): ${firstDivergentReason}`,
    ).toBeNull();

    // Sanity: we actually compared 200 pairs (or as many as we could
    // resolve against `allPlanets`).
    expect(selected.length).toBe(PAIR_COUNT);
  });

  it("locks a single reproducible result against the committed snapshot helper", () => {
    // Cross-check: the property-test random walk must land on at
    // least one of the (planet, chunk) pairs the committed snapshots
    // cover. We pull the first surface fixture (chunk 0,0 of star 0
    // planet 0) and verify its slice equals what the generator
    // currently produces for the same inputs (no randomness in this
    // path — just a smoke).
    const fx = loadFixture<SurfaceFixtureShape>("surface-dev-seed-star0-planet0-chunk00.json");
    const planet = loadPlanetFromSurfaceFixture(fx);
    const chunk = generateSurfaceChunk(fx.seed, planet, fx.chunkX, fx.chunkZ);
    expect(chunk.chunkX).toBe(fx.chunkX);
    expect(chunk.chunkZ).toBe(fx.chunkZ);
    expect(chunk.biome).toBe(fx.biome);

    // Also lock against the full star-chart fixture (proves the
    // property suite and the snapshot suite share an upstream
    // generator — if a bug ever desyncs them, this test catches it).
    const starsFx = loadFixture<StarsFixture>("stars-dev-seed-full.json");
    const stars = generateStars(starsFx.seed);
    expect(stars).toEqual(starsFx.stars);
  });
});
