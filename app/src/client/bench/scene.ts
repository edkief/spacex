/**
 * Worst-case render scene — TASK-58.
 *
 * Builds the exact scene the acceptance criteria describe: the
 * player on a surface with a full 13-chunk stream, 8 hazard cells,
 * 30 nearby deposits, 16 ships (8 players + 8 AI) in combat with
 * lasers and missiles firing at rate, and 20 remote character
 * labels. Triangle counts come from the *real* chunk geometry
 * (`generateChunk` at the profile's per-ring grid detail), so the
 * draw plan's triangle totals are measured, not guessed.
 *
 * The scene is rebuilt (with a different frame seed) every frame by
 * {@link sceneForFrame} so combat FX churn the same way they do in
 * a live match — that churn is what the FX caps have to survive.
 *
 * @see ./renderBench.ts for the frame loop + report.
 */

import { generateChunk, type ChunkDetail } from "@client/world/chunks.js";
import type { Planet } from "@shared/galaxy/types.js";
import {
  DEPOSIT_RESOURCE_TYPES,
  type SceneComposition,
  SHIP_TRIANGLES,
} from "@client/render/drawPlan.js";
import type { PerfProfile } from "@shared/perf.js";

/** Ship mix the spec calls for: 8 players + 8 AI. */
export const WORST_CASE_SHIPS = 16;
/** Distinct liveries in the mix — 6 livery pool slots, not 16. */
export const WORST_CASE_LIVERIES = 6;
/** Streamed chunks the surface profile keeps around the player. */
export const WORST_CASE_CHUNKS = 13;
/** Hazard cells streamed to the client. */
export const WORST_CASE_HAZARD_CELLS = 8;
/** Nearby deposits discovered. */
export const WORST_CASE_DEPOSITS = 30;
/** Remote character labels requested. */
export const WORST_CASE_LABELS = 20;
/** Drones patrolling the hazard cells (2 per drone cell). */
export const WORST_CASE_DRONES = 12;

/** Seed used to place the surface chunks (`bench-render-world`). */
export const BENCH_SEED = "bench-render-world";

/** Per-ring grid detail for a profile (mirrors `PipelineParams`). */
export function detailFor(profile: PerfProfile): ChunkDetail {
  return profile.id === "high"
    ? { near: 64, mid: 32, far: 8 }
    : profile.id === "medium"
      ? { near: 32, mid: 16, far: 8 }
      : { near: 16, mid: 8, far: 4 };
}

/** Per-profile chunk geometry sample, generated once and reused —
 *  the client pipeline caches chunks in an LRU (TASK-26), so the
 *  benchmark must not re-run chunk generation every frame. */
const geometryCache = new Map<string, { near: number; mid: number; far: number }>();

/**
 * Real per-ring triangle counts for one chunk at a profile's grid
 * detail, measured from `generateChunk` (not assumed) and cached.
 */
export function chunkTrianglesFor(
  planet: Planet,
  profile: PerfProfile,
): {
  near: number;
  mid: number;
  far: number;
} {
  const key = `${planet.id}:${profile.id}`;
  const cached = geometryCache.get(key);
  if (cached) return cached;
  const sample = generateChunk(BENCH_SEED, planet, 0, 0, detailFor(profile));
  const measured = {
    near: sample.geometries.near.triangleCount,
    mid: sample.geometries.mid.triangleCount,
    far: sample.geometries.far.triangleCount,
  };
  geometryCache.set(key, measured);
  return measured;
}

/**
 * Build the worst-case scene. `frameSeed` perturbs the combat FX
 * mix per frame (a plain LCG — the scene must be reproducible, not
 * random).
 */
export function sceneForFrame(
  planet: Planet,
  profile: PerfProfile,
  frameSeed: number,
): SceneComposition {
  const rng = mulberry32(frameSeed);
  // 13 chunks = 1 near + 4 mid + 8 far (the ring split the LOD
  // radii produce at the default active-set radius).
  const chunks = { near: 1, mid: 4, far: WORST_CASE_CHUNKS - 5 };
  const chunkTriangles = chunkTrianglesFor(planet, profile);

  // 30 deposits spread over the four resource types, weighted the
  // way the catalog picks them (40/30/20/10 %).
  const deposits: Record<string, number> = {};
  const weights = [0.4, 0.3, 0.2, 0.1];
  DEPOSIT_RESOURCE_TYPES.forEach((resourceType, index) => {
    deposits[resourceType] = Math.round(WORST_CASE_DEPOSITS * weights[index]!);
  });

  return {
    chunks,
    chunkTriangles,
    deposits,
    drones: WORST_CASE_DRONES,
    hazardCells: WORST_CASE_HAZARD_CELLS,
    ships: WORST_CASE_SHIPS,
    distinctLiveries: WORST_CASE_LIVERIES,
    labels: WORST_CASE_LABELS,
    stars: profile.starCount,
    // Everyone is shooting: 24 laser flashes and 20 missile
    // tracers requested, plus 6 debris sets — deliberately *over*
    // the 16 / 16 / 8 caps so the caps have to bite.
    fx: {
      "laser-flash": 20 + Math.floor(rng() * 8),
      "missile-tracer": 18 + Math.floor(rng() * 8),
      debris: 9 + Math.floor(rng() * 4),
    },
  };
}

/** Triangles one rendered ship costs — re-exported for the report. */
export const BENCH_SHIP_TRIANGLES = SHIP_TRIANGLES;

/** Deterministic per-frame PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
