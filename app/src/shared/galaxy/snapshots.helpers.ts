/**
 * Shared helpers for the TASK-6 snapshot suite (`shared/galaxy/snapshots.test.ts`).
 *
 * Mirrors the pattern of `system.helpers.ts` / `surface.helpers.ts`:
 * keeps the per-fixture loaders, mutation generator, and divergent-path
 * walker in one (non-test) module so the suite files can stay small
 * (under the 300-line ceiling mandated by AGENTS.md) and so the
 * `noUnusedLocals` TypeScript check is happy.
 *
 * The committed snapshot fixtures pin down the galaxy's static
 * geometry (SC-2): `stars` (TASK-3), `system` (TASK-4), and
 * `surface` (TASK-5) all regenerate byte-equal to the fixtures when
 * re-run from the documented seed + indices.
 *
 * @see ./snapshots.test.ts for the scenario suite.
 * @see ./snapshots.mutation.test.ts for the mutation-detection suite.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Rng, hash2, seedFromString } from "../random.js";
import { SPECTRAL_WEIGHTS } from "./config.js";
import type { Star, SystemGen, Planet } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-seed constants (used by every scenario).
// ---------------------------------------------------------------------------

/** Canonical drift dev seed (matches every other fixture). */
export const DEV_SEED = "drift-dev-seed-001";

/** Star indices the suite targets. */
export const STAR0_INDEX = 0;
export const STAR1_INDEX = 1;

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixture loading + divergent-path walker
// ---------------------------------------------------------------------------

/** Load and parse a fixture from `__fixtures__/<name>`. */
export function loadFixture<T>(name: string): T {
  const path = resolve(HERE, `__fixtures__/${name}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Walk two canonical-JSON strings in lock-step and return the first
 * divergent dot-path (or "-" if they are identical). Used to make
 * snapshot failures self-diagnosing.
 *
 * `a` and `b` must already be canonicalised (sorted keys) — that's
 * what `canonicalJson(value)` produces — so this stays a small string
 * walker with no JSON-reparsing.
 */
export function firstDivergentPath(a: unknown, b: unknown, prefix = ""): string {
  if (a === b) return "-";
  if (typeof a !== typeof b) return `${prefix}<type: ${typeof a} vs ${typeof b}>`;
  if (a === null || b === null) return `${prefix}<null mismatch>`;
  if (typeof a === "number") {
    return `${prefix}<number: ${a} vs ${b}>`;
  }
  if (typeof a === "string") {
    return `${prefix}<string: ${JSON.stringify(a)} vs ${JSON.stringify(b)}>`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return `${prefix}<array length: ${a.length} vs ${b.length}>`;
    }
    for (let i = 0; i < a.length; i++) {
      const child = firstDivergentPath(a[i], b[i], `${prefix}[${i}]`);
      if (child !== "-") return child;
    }
    return "-";
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of [...keys].sort()) {
      if (!(k in ao)) return `${prefix}.${k}<missing in actual>`;
      if (!(k in bo)) return `${prefix}.${k}<missing in expected>`;
      const child = firstDivergentPath(ao[k], bo[k], `${prefix}.${k}`);
      if (child !== "-") return child;
    }
    return "-";
  }
  return `${prefix}<unknown>`;
}

// ---------------------------------------------------------------------------
// Fixture shapes (the on-disk JSON, not the runtime generator types)
// ---------------------------------------------------------------------------

export interface StarsFixture {
  seed: string;
  count: number;
  checksum: string;
  stars: readonly Star[];
}

export interface SystemFixtureShape {
  seed: string;
  starIndex: number;
  starId: string;
  system: SystemGen;
}

export interface SurfaceFixtureShape {
  seed: string;
  star: { id: string; name: string };
  planet: {
    id: string;
    name: string;
    orbitIndex: number;
    class: string;
    radiusKm: number;
    hasAtmosphere: boolean;
    landable: boolean;
    resourceTypes: readonly string[];
  };
  chunkX: number;
  chunkZ: number;
  heightmap?: readonly number[];
  heightmap16?: readonly number[];
  heightmapStats?: { avg: number; min: number; max: number; gradient: number };
  biome: string;
  resourceNodes: readonly {
    nodeId: string;
    type: string;
    x: number;
    z: number;
    baseQuantity: number;
  }[];
  landingPads: readonly { id: string; x: number; z: number }[];
}

// ---------------------------------------------------------------------------
// Mutation generator (used only by snapshots.mutation.test.ts)
// ---------------------------------------------------------------------------

/**
 * A deliberately-mutated star generator: same algorithm as
 * `generateStars`, but the spectral-class weight for O is swapped
 * with the weight for M (the rarest class becomes the most common
 * and vice versa). Used by the mutation test to prove the snapshot
 * suite catches drift.
 *
 * We swap *just two weights* rather than reversing the whole table,
 * because we want the mutation to be clearly distinguishable from
 * the real output without depending on the sort order of
 * `Object.keys()`.
 */
export function mutatedGenerateStars(seed: string, count: number): Star[] {
  const masterSeed = seedFromString(seed);
  const out: Star[] = [];
  const master = new Rng(masterSeed);
  // Swap O ↔ M in the weight table.
  const swapped: Record<string, number> = { ...SPECTRAL_WEIGHTS };
  swapped.O = SPECTRAL_WEIGHTS.M;
  swapped.M = SPECTRAL_WEIGHTS.O;
  const totalWeight = Object.values(swapped).reduce((s, w) => s + w, 0);
  const classes = Object.keys(swapped).sort();

  for (let i = 0; i < count; i++) {
    const subSeed = hash2(masterSeed, BigInt(i));
    const idHex = subSeed.toString(16).padStart(16, "0");
    // Pick the class using the swapped weights (still drawing from
    // the master RNG so the *order* of draws is preserved — only the
    // distribution shifts).
    const r = master.nextF64() * totalWeight;
    let acc = 0;
    let chosen: string = (classes[0] as string) ?? "M";
    for (const c of classes) {
      acc += (swapped as Record<string, number>)[c] as number;
      if (r < acc) {
        chosen = c;
        break;
      }
    }
    // For the rest of the star body (position, systemCount) we draw
    // from the sub-Rng so the mutation is *only* in the class field.
    void new Rng(subSeed);
    out.push({
      id: idHex,
      name: `mutation-${i}`,
      class: chosen as Star["class"],
      x: 0,
      y: 0,
      z: 0,
      systemCount: 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Surface fixture helper (planet lookup by id)
// ---------------------------------------------------------------------------

import { generateStars } from "./stars.js";
import { generateSystemFromStar } from "./system.js";

/**
 * Returns the `Planet` referenced by a surface fixture (resolved from
 * the fixture's `planet.id` so the snapshot test stays robust to
 * ordering changes in `system.planets`).
 */
export function loadPlanetFromSurfaceFixture(fx: SurfaceFixtureShape): Planet {
  const stars = generateStars(fx.seed);
  // The fixture targets star #0 in every scenario.
  const star = stars[0]!;
  const system = generateSystemFromStar(fx.seed, star);
  const planet = system.planets.find((p) => p.id === fx.planet.id);
  if (!planet) {
    throw new Error(`planet id ${fx.planet.id} not found in star #0's system`);
  }
  return planet;
}
