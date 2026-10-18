/**
 * Chunk pipeline orchestrator (TASK-26).
 *
 * Composes the chunk key math, LRU cache, frame scheduler, and
 * triangle budget tracker into a single per-frame driver the
 * renderer calls once per render frame:
 *
 *   ```
 *   pipeline.setPlayerPosition(x, z, speed)
 *   pipeline.tick(nowMs)             // called from the render loop
 *   ```
 *
 * The pipeline:
 *
 *   1. Recomputes the active set around the player.
 *   2. Enqueues missing chunks into the frame scheduler (priority
 *      = insertion order, nearest-first).
 *   3. Calls `scheduler.tick()` to drain the generation budget.
 *   4. Surfaces the resulting chunks to the host via the `onChunk`
 *      subscriber (the renderer subscribes and mounts three.js
 *      meshes from the supplied `RenderChunk`).
 *   5. Reports per-frame triangle counts to the budget + the
 *      frame monitor's `budgetCheck` hook.
 *
 * The pipeline is **decoupled from three.js**. It exposes
 * `RenderChunk` (vertices + indices) and lets the host convert
 * that to a `BufferGeometry` however it likes. This keeps the unit
 * suite three.js-free and means the same pipeline could feed a
 * worker thread, a WebGPU mesh pipeline, or a server-side
 * thumbnailer.
 *
 * @see ./chunks.ts for the pure chunk types + helpers.
 * @see ./frameScheduler.ts for the time-sliced executor.
 */

import type { Planet } from "@shared/galaxy/types.js";

import {
  ChunkLruCache,
  CHUNK_LRU_CAPACITY,
  computeActiveSet,
  generateChunk,
  type ActiveChunk,
  type ChunkClock,
  type ChunkLOD,
  type RenderChunk,
  TriangleBudget,
  TRIANGLE_BUDGET_DEFAULT,
  defaultChunkClock,
  lodFor,
} from "./chunks.js";
import { FrameScheduler, type FrameTask } from "./frameScheduler.js";

/** Listener for chunk events. `mounted` fires once per chunk the first
 *  time it becomes available; `evicted` fires once when the LRU drops
 *  it. `lod-changed` fires when a chunk re-appears at a different LOD
 *  ring (the host re-renders the matching three.js mesh). */
export interface ChunkPipelineCallbacks {
  onMount?(chunk: RenderChunk, lod: ChunkLOD): void;
  onEvict?(chunk: RenderChunk): void;
  onLodChange?(chunk: RenderChunk, prevLod: ChunkLOD, nextLod: ChunkLOD): void;
  /** Fires every frame after `tick` returns. Used by the
   *  `FrameMonitor.budgetCheck` hook. */
  onBudgetCheck?(budgetMs: number, exceeded: boolean): void;
}

/** Options for `ChunkPipeline`. */
export interface ChunkPipelineOptions {
  /** Galaxy seed (used by `generateChunk`). */
  seed: string;
  /** Planet the player is currently standing on / over. */
  planet: Planet;
  /** LRU cap (default `CHUNK_LRU_CAPACITY`). */
  lruCapacity?: number;
  /** Per-frame generation budget in ms (default `4`). */
  budgetMs?: number;
  /** Triangle budget cap (default `TRIANGLE_BUDGET_DEFAULT`). */
  triangleBudget?: number;
  /** Optional clock — defaults to `defaultChunkClock`. */
  clock?: ChunkClock;
  /** Optional callbacks — all are no-ops when omitted. */
  callbacks?: ChunkPipelineCallbacks;
}

/**
 * Diagnostic snapshot — exposed via `getStats()` so the debug
 * overlay can surface chunk counts without instrumenting the
 * pipeline internals.
 */
export interface ChunkPipelineStats {
  /** Total cached chunks. */
  cached: number;
  /** Active set size (post-LOD-filter). */
  activeSetSize: number;
  /** Total triangles currently counted toward the budget. */
  triangles: number;
  /** `true` if `triangles > triangleBudget`. */
  overBudget: boolean;
  /** Last frame's wall-clock cost of `tick()`, ms. */
  lastTickMs: number;
  /** Tasks completed across the pipeline's lifetime. */
  completedTasks: number;
  /** Last per-frame budget overrun, ms. */
  lastOverrunMs: number;
}

/**
 * The pipeline. Stateful (LRU + scheduler + budget), but the state
 * is all derivable from `(seed, planet, player position)` so two
 * pipelines started with the same seed produce identical chunks.
 */
export class ChunkPipeline {
  readonly seed: string;
  readonly planet: Planet;
  readonly lru: ChunkLruCache;
  readonly scheduler: FrameScheduler;
  readonly budget: TriangleBudget;

  private readonly callbacks: ChunkPipelineCallbacks;
  private readonly clock: ChunkClock;
  // Player position is mutable so `setPlayerPosition` can update
  // it; the readonly markers are intentionally suppressed here so
  // the API reads as "constants the renderer sets once per frame".
  // The fields are private so external mutation is impossible.
  private playerState: { x: number; z: number; speed: number } = {
    x: 0,
    z: 0,
    speed: 0,
  };

  /** LOD ring currently displayed for each chunk. */
  private readonly chunkLod = new Map<string, ChunkLOD>();

  private lastTickMs = 0;
  private activeSetSize = 0;

  constructor(opts: ChunkPipelineOptions) {
    this.seed = opts.seed;
    this.planet = opts.planet;
    this.lru = new ChunkLruCache(opts.lruCapacity ?? CHUNK_LRU_CAPACITY);
    this.scheduler = new FrameScheduler({
      budgetMs: opts.budgetMs ?? 4,
      clock: opts.clock ?? defaultChunkClock,
    });
    this.budget = new TriangleBudget(opts.triangleBudget ?? TRIANGLE_BUDGET_DEFAULT);
    this.callbacks = opts.callbacks ?? {};
    this.clock = opts.clock ?? defaultChunkClock;

    // Eviction → host callback.
    this.lru.onEvict((chunk) => {
      this.budget.forget(chunk.key);
      this.chunkLod.delete(chunk.key);
      this.callbacks.onEvict?.(chunk);
    });
  }

  /** Update the player's position and speed. Safe to call every frame. */
  setPlayerPosition(worldX: number, worldZ: number, speedMps: number = 0): void {
    this.playerState.x = worldX;
    this.playerState.z = worldZ;
    this.playerState.speed = speedMps;
  }

  /**
   * Run one frame's work:
   *   - Recompute the active set.
   *   - Enqueue missing chunks.
   *   - Drain the scheduler up to the budget.
   *   - Mount the freshly-generated chunks via `onMount`.
   *   - Fire `onBudgetCheck` so the host can pipe into
   *     `FrameMonitor.budgetCheck`.
   */
  tick(): void {
    const start = this.clock();
    const activeSet = computeActiveSet(
      this.playerState.x,
      this.playerState.z,
      this.playerState.speed,
    );
    this.activeSetSize = activeSet.length;

    // Enqueue missing chunks. We process nearest-first because the
    // active set is sorted by distance (see `computeActiveSet`).
    for (const active of activeSet) {
      const key = chunkKeyFor(this.planet.id, active.chunkX, active.chunkZ);
      if (this.lru.has(key)) {
        // Already cached — check for an LOD ring change.
        const prev = this.chunkLod.get(key);
        if (prev !== undefined && prev !== active.lod) {
          this.chunkLod.set(key, active.lod);
          const chunk = this.lru.get(key);
          if (chunk !== undefined) {
            this.callbacks.onLodChange?.(chunk, prev, active.lod);
          }
        } else if (prev === undefined) {
          this.chunkLod.set(key, active.lod);
        }
        continue;
      }
      this.scheduler.push({
        id: key,
        run: () => this.generateAndMount(active),
      });
    }

    const completed = this.scheduler.tick();
    void completed;

    const elapsed = this.clock() - start;
    this.lastTickMs = elapsed;

    const exceeded = this.budget.isOverBudget();
    this.callbacks.onBudgetCheck?.(elapsed, exceeded);
  }

  /** Snapshot the pipeline stats for the debug overlay. */
  getStats(): ChunkPipelineStats {
    return {
      cached: this.lru.size(),
      activeSetSize: this.activeSetSize,
      triangles: this.budget.total(),
      overBudget: this.budget.isOverBudget(),
      lastTickMs: this.lastTickMs,
      completedTasks: this.scheduler.completedCount,
      lastOverrunMs: this.scheduler.lastOverrunMs,
    };
  }

  /** Dispose every cached chunk + clear the scheduler. */
  dispose(): void {
    this.scheduler.clear();
    this.lru.clear();
    this.budget.reset();
    this.chunkLod.clear();
  }

  // -----------------------------------------------------------------
  // Internal: chunk generation step
  // -----------------------------------------------------------------

  /**
   * Generate a single chunk, insert it into the LRU, and notify
   * the host. The `onMount` callback fires inside this method
   * (synchronously) so the host sees the chunk in the same frame
   * the LRU learns about it.
   */
  private generateAndMount(active: ActiveChunk): void {
    const chunk = generateChunk(this.seed, this.planet, active.chunkX, active.chunkZ);
    this.lru.set(chunk.key, chunk);
    this.chunkLod.set(chunk.key, active.lod);
    this.budget.record(chunk.key, "near", chunk.geometries.near.triangleCount);
    this.budget.record(chunk.key, "mid", chunk.geometries.mid.triangleCount);
    this.budget.record(chunk.key, "far", chunk.geometries.far.triangleCount);
    this.callbacks.onMount?.(chunk, active.lod);
  }
}

/** Local re-export so callers don't need to import `chunkKey` directly. */
function chunkKeyFor(planetId: string, chunkX: number, chunkZ: number): string {
  return `${planetId}:${chunkX}:${chunkZ}`;
}

/**
 * Helper: find the LOD ring that owns a chunk at a given distance
 * from the player. Re-exports `lodFor` so the orchestrator file is
 * the single import for the renderer code path.
 */
export { lodFor };

// Silence "unused parameter" warnings on the diagnostic snapshot
// fields — they exist for the host to read, not for the pipeline
// to consume directly.
void (null as unknown as FrameTask);
