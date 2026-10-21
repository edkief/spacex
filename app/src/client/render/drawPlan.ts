/**
 * Draw-plan planner — TASK-58 (pass 1 + 2: instancing and
 * per-ring chunk merging).
 *
 * A pure function from "what the world contains this frame" to
 * "what the GPU is asked to draw". It is the single place the
 * batching strategy lives, so the headless benchmark, the debug
 * overlay and the (future) three.js renderer all agree on the draw
 * counts:
 *
 *   - **Surface chunks** are merged per LOD ring: one merged mesh
 *     per `(planet, ring)` instead of one mesh per chunk
 *     (13 chunks → ≤ 3 draw calls).
 *   - **Deposits** are instanced per resource type — 4 resource
 *     types → ≤ 4 draw calls for any number of deposits.
 *   - **Drones** are a single instanced batch regardless of count.
 *   - **Ships** share a livery material pool (`LIVERY_POOL_SIZE`
 *     slots, per-ship colour carried as an instance attribute) —
 *     no per-entity material clone.
 *   - **Stars** are one points cloud.
 *   - **Remote labels** are a DOM/SVG overlay, so they cost 0 draw
 *     calls; they are capped by `profile.maxLabels`.
 *   - **FX** are one instanced batch per kind, capped by the
 *     profile's FX caps (the registry refuses the overflow).
 *
 * The plan is deliberately free of three.js so it runs in Node —
 * that is what makes the benchmark and its CI fast version
 * possible.
 */

import {
  evaluateBudgets,
  fxCapFor,
  PERF_CAPPED_FX_KINDS,
  type CappedFxKind,
  type PerfProfile,
  type PerfMetrics,
} from "@shared/perf.js";

/** Ship livery material pool. Per-ship colour rides an instance
 *  attribute, so 16 ships with 6 distinct liveries cost 6 slots,
 *  never 16 materials. */
export const LIVERY_POOL_SIZE = 24;

/** Triangles one deposit instance costs (a low-poly ore boulder). */
export const DEPOSIT_TRIANGLES = 200;
/** Triangles one drone instance costs (an octahedron hull). */
export const DRONE_TRIANGLES = 48;
/** Triangles one rendered ship costs (the ship-class mesh). */
export const SHIP_TRIANGLES = 4_000;
/** Triangles one laser flash quad costs. */
export const LASER_TRIANGLES = 4;
/** Triangles one missile tracer costs. */
export const MISSILE_TRIANGLES = 24;
/** Debris shards per explosion debris set (TASK-49 `DEBRIS_COUNT`). */
export const DEBRIS_SHARDS = 8;
/** Triangles one debris shard costs. */
export const DEBRIS_TRIANGLES = 12;
/** Resource-type ids deposits are instanced by (TASK-37 catalog). */
export const DEPOSIT_RESOURCE_TYPES = ["iron", "copper", "rare-earths", "crystal"] as const;

/** What the world contains this frame. */
export interface SceneComposition {
  /** Streamed chunks per LOD ring around the player. */
  readonly chunks: Readonly<{ near: number; mid: number; far: number }>;
  /** Triangles one chunk contributes at each LOD ring. */
  readonly chunkTriangles: Readonly<{ near: number; mid: number; far: number }>;
  /** Nearby deposits, counted per resource type. */
  readonly deposits: Readonly<Record<string, number>>;
  /** Hostile drones in the streamed hazard cells. */
  readonly drones: number;
  /** Hazard cells streamed to the client (overlay, not 3-D). */
  readonly hazardCells: number;
  /** Rendered ships (players + AI + wrecks). */
  readonly ships: number;
  /** Distinct liveries among the rendered ships. */
  readonly distinctLiveries: number;
  /** Remote character labels requested this frame. */
  readonly labels: number;
  /** Background stars. */
  readonly stars: number;
  /** Concurrent FX requested this frame (before capping). */
  readonly fx: Readonly<Record<CappedFxKind, number>>;
}

/** One submitted batch. */
export interface DrawBatch {
  /** Stable batch name (`terrain:mid`, `deposits:iron`, …). */
  readonly name: string;
  /** How the batch is submitted. */
  readonly kind: "merged-chunk-ring" | "instanced" | "points" | "pooled-material" | "dom-overlay";
  /** Draw calls this batch costs. */
  readonly drawCalls: number;
  /** Instances (merged vertices for a merged ring batch). */
  readonly instances: number;
  /** Triangles this batch submits. */
  readonly triangles: number;
  /** Distinct materials this batch binds. */
  readonly materials: number;
}

/** The whole frame's draw plan. */
export interface DrawPlan {
  readonly batches: readonly DrawBatch[];
  readonly metrics: PerfMetrics;
  /** `true` when every profile budget is green. */
  readonly withinBudget: boolean;
}

/** Options for {@link planDraws}. */
export interface DrawPlanOptions {
  /** `tuned: true` (default) applies every TASK-58 pass. `false`
   *  reproduces the pre-tuning renderer: one mesh per chunk at full
   *  detail, one mesh + one material per entity, one draw per FX
   *  instance, no instancing, no caps. Used as the benchmark
   *  baseline for the ≥ 30 % delta target. */
  readonly tuned?: boolean;
  /** Instances packed into one instanced draw call when untuned
   *  (the naive renderer flushed every 500 instances). */
  readonly naiveBatchSize?: number;
}

/** Naive renderer's instances-per-draw-call (pre-tuning baseline). */
export const NAIVE_BATCH_SIZE = 500;

/**
 * Plan one frame's draws from a scene composition.
 *
 * `planDraws(scene, { tuned: false }, profile)` is the
 * pre-tuning baseline the benchmark measures against; the tuned
 * plan is what the client renderer will eventually submit.
 */
export function planDraws(
  scene: SceneComposition,
  options: DrawPlanOptions,
  profile: PerfProfile,
): DrawPlan {
  const tuned = options.tuned !== false;
  const batchSize = tuned
    ? profile.instanceBatchSize
    : (options.naiveBatchSize ?? NAIVE_BATCH_SIZE);
  const batches: DrawBatch[] = [];

  // --- Surface terrain -------------------------------------------------
  // Tuned: merge every chunk of a ring into one mesh (1 draw call,
  // 1 shared terrain material). Untuned: one full-detail mesh per
  // chunk, no LOD.
  if (tuned) {
    for (const ring of ["near", "mid", "far"] as const) {
      const count = scene.chunks[ring];
      if (count <= 0) continue;
      batches.push({
        name: `terrain:${ring}`,
        kind: "merged-chunk-ring",
        drawCalls: 1,
        instances: count,
        triangles: count * scene.chunkTriangles[ring],
        materials: 1,
      });
    }
  } else {
    const count = scene.chunks.near + scene.chunks.mid + scene.chunks.far;
    if (count > 0) {
      batches.push({
        name: "terrain:per-chunk",
        kind: "merged-chunk-ring",
        drawCalls: count,
        instances: count,
        triangles: count * scene.chunkTriangles.near,
        materials: count,
      });
    }
  }

  // --- Deposits --------------------------------------------------------
  const depositTriangles = depositInstanceCount(scene) * DEPOSIT_TRIANGLES;
  if (tuned) {
    for (const resourceType of DEPOSIT_RESOURCE_TYPES) {
      const count = scene.deposits[resourceType] ?? 0;
      if (count <= 0) continue;
      batches.push({
        name: `deposits:${resourceType}`,
        kind: "instanced",
        drawCalls: instanceDrawCalls(count, batchSize),
        instances: count,
        triangles: count * DEPOSIT_TRIANGLES,
        materials: 1,
      });
    }
  } else {
    const count = depositInstanceCount(scene);
    if (count > 0) {
      batches.push({
        name: "deposits:per-entity",
        kind: "instanced",
        drawCalls: count,
        instances: count,
        triangles: depositTriangles,
        materials: count,
      });
    }
  }

  // --- Drones ----------------------------------------------------------
  if (scene.drones > 0) {
    batches.push({
      name: "drones",
      kind: "instanced",
      drawCalls: tuned ? instanceDrawCalls(scene.drones, batchSize) : scene.drones,
      instances: scene.drones,
      triangles: scene.drones * DRONE_TRIANGLES,
      materials: tuned ? 1 : scene.drones,
    });
  }

  // --- Ships (livery material pool) ------------------------------------
  if (scene.ships > 0) {
    const slots = Math.min(
      tuned ? LIVERY_POOL_SIZE : scene.ships,
      Math.max(1, Math.min(scene.ships, scene.distinctLiveries)),
    );
    batches.push({
      name: "ships",
      kind: tuned ? "pooled-material" : "instanced",
      drawCalls: tuned ? instanceDrawCalls(Math.ceil(scene.ships / slots), 1) : scene.ships,
      instances: scene.ships,
      triangles: scene.ships * SHIP_TRIANGLES,
      materials: slots,
    });
  }

  // --- Stars (single points cloud) --------------------------------------
  if (scene.stars > 0) {
    batches.push({
      name: "stars",
      kind: "points",
      drawCalls: tuned ? 1 : instanceDrawCalls(scene.stars, batchSize),
      instances: tuned ? Math.min(scene.stars, profile.starCount) : scene.stars,
      triangles: 0,
      materials: 1,
    });
  }

  // --- Remote labels (DOM overlay, capped) ------------------------------
  const labels = tuned ? Math.min(scene.labels, profile.maxLabels) : scene.labels;
  if (labels > 0) {
    batches.push({
      name: "labels",
      kind: "dom-overlay",
      drawCalls: 0,
      instances: labels,
      triangles: 0,
      materials: 0,
    });
  }

  // --- FX (one instanced batch per kind, capped) ------------------------
  const fxCounts: Record<CappedFxKind, number> = {
    "laser-flash": 0,
    "missile-tracer": 0,
    debris: 0,
  };
  for (const kind of PERF_CAPPED_FX_KINDS) {
    const requested = scene.fx[kind] ?? 0;
    if (requested <= 0) continue;
    const count = tuned ? Math.min(requested, fxCapFor(kind, profile)) : requested;
    fxCounts[kind] = count;
    batches.push({
      name: `fx:${kind}`,
      kind: "instanced",
      drawCalls: tuned ? instanceDrawCalls(count, batchSize) : count,
      instances: count,
      triangles: fxTrianglesFor(kind, count),
      materials: 1,
    });
  }

  const metrics = summarise(batches, labels, fxCounts);
  return {
    batches,
    metrics,
    withinBudget: evaluateBudgets(metrics, profile).ok,
  };
}

/** Triangles one instance of a capped FX kind costs. */
function fxTrianglesFor(kind: CappedFxKind, count: number): number {
  if (kind === "laser-flash") return count * LASER_TRIANGLES;
  if (kind === "missile-tracer") return count * MISSILE_TRIANGLES;
  return count * DEBRIS_SHARDS * DEBRIS_TRIANGLES;
}

/** Draw calls needed for `count` instances at `batchSize` per call. */
function instanceDrawCalls(count: number, batchSize: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, batchSize)));
}

/** Total deposits across every resource type. */
function depositInstanceCount(scene: SceneComposition): number {
  let total = 0;
  for (const value of Object.values(scene.deposits)) total += value;
  return total;
}

/** Roll the batches up into the metrics the budgets read. */
function summarise(
  batches: readonly DrawBatch[],
  labels: number,
  fx: Record<CappedFxKind, number>,
): PerfMetrics {
  let drawCalls = 0;
  let triangles = 0;
  let instances = 0;
  let surfaceTriangles = 0;
  for (const batch of batches) {
    drawCalls += batch.drawCalls;
    triangles += batch.triangles;
    if (batch.kind === "dom-overlay") continue;
    instances += batch.instances;
    if (batch.name.startsWith("terrain")) surfaceTriangles += batch.triangles;
  }
  return {
    drawCalls,
    triangles,
    materials: countMaterials(batches),
    surfaceTriangles,
    labels,
    instances,
    fx,
  };
}

/**
 * Distinct materials in the plan. Every batch reports how many
 * materials it binds: a merged ring or an instanced batch binds one,
 * a livery pool binds one per occupied slot, and the untuned
 * per-entity renderer binds one per entity (the explosion TASK-58's
 * material pool removes).
 */
function countMaterials(batches: readonly DrawBatch[]): number {
  let materials = 0;
  for (const batch of batches) materials += batch.materials;
  return materials;
}
