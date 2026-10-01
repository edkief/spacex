import { perfWarn } from './logger';
import { renderedEntityCount } from '@client/world/entity-registry';

/**
 * TASK-57: the in-game frame monitor — rolling frame-time telemetry for
 * the debug overlay (F3, dev only) and the perf-budget hook the other
 * performance tasks (TASK-30/58/59/61) verify against.
 *
 * The render loop (WorldManager, boot starfield) calls `beginFrame()` at
 * the top of each frame and `endFrame()` right after `renderer.render()` —
 * three.js resets `renderer.info.render` on every render, so draw calls /
 * triangles must be captured between the render and the next frame.
 *
 * All timing goes through injectable timestamps (defaults to
 * `performance.now()`), so the window math is unit-testable without
 * real frames.
 */

/** Rolling frame-time window: the last 300 frames. */
export const FRAME_WINDOW_SIZE = 300;
/** FPS is counted over a 1 s window of frame-end timestamps. */
export const FPS_WINDOW_MS = 1000;
/** A budget warning for a given name is emitted at most once per 10 s. */
export const BUDGET_WARN_COOLDOWN_MS = 10_000;

export interface FrameStats {
  /** Frames completed in the last 1 s. */
  fps: number;
  /** Frame time percentiles (ms) over the last 300 frames. */
  frameTimeP50Ms: number;
  frameTimeP95Ms: number;
  frameTimeP99Ms: number;
  /** renderer.info.render of the last rendered frame. */
  drawCalls: number;
  triangles: number;
  /** Entities currently rendered (client entity registry). */
  entities: number;
  /**
   * Triangle counts by category, set per frame by the reporters
   * (TASK-26: 'surface-near' / 'surface-mid' / 'surface-far' from the
   * chunk scene). Empty until a category reporter runs.
   */
  categoryTriangles: Record<string, number>;
}

export interface BudgetStats {
  /** Registered budget in ms (null when the name has none yet). */
  budgetMs: number | null;
  /** Slowest measured phase (ms) since the last reset, per name. */
  maxMs: number;
  /** Warnings emitted for this name since the last reset. */
  warnings: number;
}

/** Telemetry for one gauge (unit-agnostic threshold, e.g. triangle counts). */
export interface GaugeStats {
  /** Registered limit (null when the name has none yet). */
  limit: number | null;
  /** Largest measured value since the last reset, per name. */
  maxValue: number;
  /** Warnings emitted for this name since the last reset. */
  warnings: number;
}

/** Fixed-capacity circular buffer of numbers, oldest evicted first. */
class RingBuffer {
  private readonly buf: number[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array<number>(capacity).fill(0);
  }

  push(value: number): void {
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  get length(): number {
    return this.size;
  }

  /** Newest-last iteration over the current window. */
  *[Symbol.iterator](): IterableIterator<number> {
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) yield this.buf[(start + i) % this.capacity];
  }

  /**
   * p-th percentile (0-100), nearest-rank: ceil(p% of n)-th smallest
   * value. Deterministic — no interpolation, so p95 of [1..100] is 95.
   */
  percentile(p: number): number {
    if (this.size === 0) return 0;
    const sorted = Array.from(this).sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
  }
}

export class FrameMonitor {
  private readonly frames = new RingBuffer(FRAME_WINDOW_SIZE);
  private readonly frameEnds = new RingBuffer(FRAME_WINDOW_SIZE + 16);
  private beginMs = -1;
  private lastRender = { drawCalls: 0, triangles: 0 };
  private readonly budgets = new Map<string, number>();
  private readonly budgetMax = new Map<string, number>();
  private readonly budgetLastWarnAt = new Map<string, number>();
  private readonly budgetWarnings = new Map<string, number>();
  /** Unit-agnostic gauges (TASK-26: triangle-count limits, not ms). */
  private readonly gauges = new Map<string, number>();
  private readonly gaugeMax = new Map<string, number>();
  private readonly gaugeLastWarnAt = new Map<string, number>();
  private readonly gaugeWarnings = new Map<string, number>();
  /** Per-category triangle counts for the current frame (replaced per frame). */
  private categoryTriangles: Record<string, number> = {};

  /** Top of a frame: start the frame-time clock. */
  beginFrame(nowMs = performance.now()): void {
    this.beginMs = nowMs;
  }

  /**
   * Bottom of a frame, right after `renderer.render()`. Records the frame
   * time + end timestamp and (when given) the renderer stats of the frame
   * just rendered.
   */
  endFrame(
    renderInfo?: { drawCalls: number; triangles: number } | null,
    nowMs = performance.now(),
  ): void {
    const frameMs = this.beginMs >= 0 ? Math.max(0, nowMs - this.beginMs) : 0;
    this.beginMs = -1;
    this.frames.push(frameMs);
    this.frameEnds.push(nowMs);
    if (renderInfo) this.lastRender = { ...renderInfo };
  }

  /** Current snapshot — the overlay polls this at 2 Hz; tests call it directly. */
  getFrameStats(): FrameStats {
    const latest = this.frameEnds.length > 0 ? [...this.frameEnds].at(-1)! : 0;
    let fps = 0;
    for (const end of this.frameEnds) {
      if (latest - end <= FPS_WINDOW_MS) fps += 1;
    }
    return {
      fps,
      frameTimeP50Ms: this.frames.percentile(50),
      frameTimeP95Ms: this.frames.percentile(95),
      frameTimeP99Ms: this.frames.percentile(99),
      drawCalls: this.lastRender.drawCalls,
      triangles: this.lastRender.triangles,
      entities: renderedEntityCount(),
      categoryTriangles: { ...this.categoryTriangles },
    };
  }

  /**
   * Replace the per-frame per-category triangle counts (e.g. the chunk
   * scene's near/mid/far tally). Called once per frame by each reporter.
   */
  reportCategories(categories: Record<string, number>): void {
    this.categoryTriangles = { ...categories };
  }

  /** Register the budget (ms) a named phase must stay under. */
  registerBudget(name: string, budgetMs: number): void {
    this.budgets.set(name, budgetMs);
  }

  /**
   * Check a measured phase against its registered budget. Keeps the
   * rolling max per name and emits at most one warning per name per
   * 10 s (the shared mechanism for all perf-budget tasks).
   */
  budgetCheck(name: string, measuredMs: number, nowMs = performance.now()): void {
    const prevMax = this.budgetMax.get(name) ?? 0;
    this.budgetMax.set(name, Math.max(prevMax, measuredMs));

    const budget = this.budgets.get(name);
    const message =
      budget === undefined
        ? `perf budget missing: "${name}" measured ${measuredMs.toFixed(2)} ms but no budget is registered`
        : `perf budget exceeded: "${name}" took ${measuredMs.toFixed(2)} ms (budget ${budget} ms)`;
    if (budget === undefined || measuredMs > budget) {
      const last = this.budgetLastWarnAt.get(name);
      if (last === undefined || nowMs - last >= BUDGET_WARN_COOLDOWN_MS) {
        this.budgetLastWarnAt.set(name, nowMs);
        this.budgetWarnings.set(name, (this.budgetWarnings.get(name) ?? 0) + 1);
        perfWarn(message, { name, measuredMs, budgetMs: budget ?? null });
      }
    }
  }

  /** Telemetry for one budgeted phase (tests + future stats export). */
  getBudgetStats(name: string): BudgetStats {
    return {
      budgetMs: this.budgets.get(name) ?? null,
      maxMs: this.budgetMax.get(name) ?? 0,
      warnings: this.budgetWarnings.get(name) ?? 0,
    };
  }

  /** Register the limit a named gauge (unit-agnostic) must stay under. */
  registerGauge(name: string, limit: number): void {
    this.gauges.set(name, limit);
  }

  /**
   * Check a measured value against its registered gauge limit. Same
   * rolling-max + rate-limited warning mechanism as budgetCheck, but the
   * unit is whatever the reporter measures (TASK-26: triangle counts).
   */
  gaugeCheck(name: string, value: number, nowMs = performance.now()): void {
    const prevMax = this.gaugeMax.get(name) ?? 0;
    this.gaugeMax.set(name, Math.max(prevMax, value));

    const limit = this.gauges.get(name);
    const message =
      limit === undefined
        ? `perf gauge missing: "${name}" at ${Math.round(value)} but no limit is registered`
        : `perf gauge exceeded: "${name}" at ${Math.round(value)} (limit ${limit})`;
    if (limit === undefined || value > limit) {
      const last = this.gaugeLastWarnAt.get(name);
      if (last === undefined || nowMs - last >= BUDGET_WARN_COOLDOWN_MS) {
        this.gaugeLastWarnAt.set(name, nowMs);
        this.gaugeWarnings.set(name, (this.gaugeWarnings.get(name) ?? 0) + 1);
        perfWarn(message, { name, value, limit: limit ?? null });
      }
    }
  }

  /** Telemetry for one gauge (tests + future stats export). */
  getGaugeStats(name: string): GaugeStats {
    return {
      limit: this.gauges.get(name) ?? null,
      maxValue: this.gaugeMax.get(name) ?? 0,
      warnings: this.gaugeWarnings.get(name) ?? 0,
    };
  }

  /** Drop all telemetry (new session / tests). */
  reset(): void {
    this.frames.reset();
    this.frameEnds.reset();
    this.beginMs = -1;
    this.lastRender = { drawCalls: 0, triangles: 0 };
    this.budgets.clear();
    this.budgetMax.clear();
    this.budgetLastWarnAt.clear();
    this.budgetWarnings.clear();
    this.gauges.clear();
    this.gaugeMax.clear();
    this.gaugeLastWarnAt.clear();
    this.gaugeWarnings.clear();
    this.categoryTriangles = {};
  }
}

/** The single app-wide monitor instance (render loop + overlay + tests). */
export const frameMonitor = new FrameMonitor();
