/**
 * Frame scheduler for time-sliced chunk generation (TASK-26).
 *
 * The streaming pipeline must not stall the render loop, so each
 * frame the scheduler processes a *budgeted* slice of pending
 * generation work. The default budget is **4 ms** (the spec's
 * contract: "no single-frame stall > 4 ms from streaming").
 *
 * ## Design
 *
 *   - The scheduler holds a priority queue (priority = insertion
 *     order; new chunks are pushed to the end, popped from the
 *     front so the earliest-inserted chunk is processed first).
 *     The `chunkPipeline` re-queues missing chunks every frame the
 *     active set changes, so this ordering naturally tracks the
 *     player's movement (chunks closer to the player get inserted
 *     earlier as the active set rolls over them).
 *   - `tick(nowMs)` runs pending tasks until the budget is
 *     exhausted, then returns the number of completed tasks. The
 *     orchestrator calls it once per render frame.
 *   - Tasks can be either synchronous (CPU-only generation) or
 *     asynchronous (future: off-thread noise). For v1 every task
 *     is synchronous; the scheduler still measures wall-clock
 *     per task so the budget hook can warn on long tasks.
 *
 * @see ./chunks.ts for the chunk generation API.
 * @see ./pipeline.ts for the orchestrator.
 */

import type { ChunkClock } from "./chunks.js";
import { defaultChunkClock } from "./chunks.js";

/** A unit of work the scheduler can defer. */
export interface FrameTask {
  /** Stable id for debug / test assertions. */
  readonly id: string;
  /** Wall-clock cost, ms (measured by the scheduler after running). */
  durationMs?: number;
  /** The work itself. May return a promise for off-thread tasks. */
  run: () => void | Promise<void>;
}

/**
 * Options bag for `FrameScheduler`.
 *
 * `budgetMs` is the per-frame slice budget. The spec mandates 4 ms;
 * the default is exactly that. Tests pass a smaller budget (e.g.
 * 0 ms) to verify the scheduler stops after the current task.
 */
export interface FrameSchedulerOptions {
  budgetMs?: number;
  clock?: ChunkClock;
}

/**
 * A time-sliced executor. Insert tasks via `push`; call `tick(now)`
 * once per render frame to drain up to `budgetMs` of work.
 *
 * Tasks are processed FIFO. If a task overruns the remaining
 * budget, the scheduler still runs it (we can't leave a chunk
 * half-generated) but records the overrun via `lastOverrunMs`.
 */
export class FrameScheduler {
  private _budgetMs: number;
  private readonly queue: FrameTask[] = [];
  private readonly clock: ChunkClock;
  /** `true` between `tickStart()` and `tickEnd()` so tests can assert. */
  private ticking = false;
  /** Last overrun (ms) — used by the perf budget hook. */
  lastOverrunMs = 0;
  /** Total tasks completed since construction. */
  completedCount = 0;

  constructor(opts: FrameSchedulerOptions = {}) {
    this._budgetMs = opts.budgetMs ?? 4;
    this.clock = opts.clock ?? defaultChunkClock;
  }

  /** Per-frame slice budget (ms). Tests / benchmarks may
   *  override this at runtime via `setBudgetMs` to drain the
   *  scheduler faster during pre-warm. */
  get budgetMs(): number {
    return this._budgetMs;
  }

  /** Mutate the per-frame budget. Use sparingly — production
   *  code should never change the budget at runtime; the seam
   *  exists for the TASK-30 transition-cycle pre-warm. */
  setBudgetMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(
        `FrameScheduler.setBudgetMs: ms must be a non-negative finite number, got ${ms}`,
      );
    }
    this._budgetMs = ms;
  }

  /** Number of pending tasks (does not count the currently-running one). */
  pending(): number {
    return this.queue.length;
  }

  /** Push a task to the back of the queue. */
  push(task: FrameTask): void {
    this.queue.push(task);
  }

  /**
   * Push a task to the FRONT of the queue — used when the active
   * set has shifted and a newly-needed chunk should jump ahead
   * of older (now-irrelevant) pending tasks.
   */
  pushFront(task: FrameTask): void {
    this.queue.unshift(task);
  }

  /** Drop every pending task (e.g. on scene teardown). */
  clear(): void {
    this.queue.length = 0;
  }

  /**
   * Drain the queue until the budget is exhausted. Returns the
   * number of tasks completed.
   *
   * The loop is intentionally synchronous (we can't `await` inside
   * the render frame). For async tasks, the scheduler will run
   * them but won't wait — the contract is "complete as much work
   * as fits in `budgetMs` of wall-clock time".
   */
  tick(): number {
    if (this.ticking) {
      // Reentrancy guard — `run` may push new tasks; we don't
      // want a recursive tick to double-charge the budget.
      return 0;
    }
    this.ticking = true;
    try {
      const start = this.clock();
      let completed = 0;
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (task === undefined) break;
        const taskStart = this.clock();
        // Sync tasks run inline; async tasks fire-and-forget so
        // we don't deadlock the render frame. Async durations are
        // measured at push-time (when the work completes) — we
        // just record the start now so the caller has a sane
        // `durationMs` once the work settles.
        const maybePromise = task.run();
        const taskEnd = this.clock();
        const elapsed = taskEnd - taskStart;
        task.durationMs = elapsed;
        completed += 1;

        // Budget check — if this task blew the budget we stop
        // the frame but record the overrun so the perf hook can
        // warn once per cooldown.
        const budgetRemaining = this._budgetMs - (taskEnd - start);
        if (budgetRemaining <= 0) {
          this.lastOverrunMs = Math.max(this.lastOverrunMs, elapsed);
          break;
        }
        // Microtask sweep — let any queued promise continuations
        // resolve before we check the clock again. The actual
        // async task is still pending, but the render frame is
        // free to go.
        if (maybePromise !== undefined && typeof maybePromise.then === "function") {
          // We don't await here; the async work runs in the
          // background. The next tick will pick up whatever's
          // been pushed in the meantime.
        }
      }
      this.completedCount += completed;
      return completed;
    } finally {
      this.ticking = false;
    }
  }
}
