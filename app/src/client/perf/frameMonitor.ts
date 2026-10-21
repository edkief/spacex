/**
 * In-game frame monitor (TASK-57).
 *
 * A dev-mode rolling-window frame-time / draw-call / triangle /
 * entity telemetry store. The overlay (`DebugOverlay.tsx`) reads
 * from this monitor at 2 Hz so the on-screen widget never itself
 * contributes to per-frame render cost. The `budgetCheck` hook
 * is the shared seam every perf task (TASK-30, TASK-58,
 * TASK-59, TASK-61) calls into when timing a pipeline phase.
 *
 * ## Design
 *
 * - The rolling window is a fixed-size circular buffer (300
 *   frames ≈ 5 s at 60 fps) of frame times in milliseconds.
 *   Reading the p50/p95/p99 on demand is O(n) over the filled
 *   region; the overlay asks at 2 Hz so the work is negligible
 *   in aggregate. We avoid an insertion-sort heap because the
 *   overhead per `recordFrameTime` is the dominant cost and a
 *   sort happens at most twice per second.
 *
 * - `recordFrameTime(nowMs)` measures the delta against the
 *   previous recorded sample. We deliberately don't hook into
 *   three.js here so this module stays a pure data store with
 *   no DOM / GL dependencies — that makes it cheap to
 *   unit-test under Node. The render loop in TASK-26+ will
 *   call `recordFrameTime(performance.now())` once per frame;
 *   `recordRendererInfo` is called once after
 *   `renderer.render` so we capture three.js' per-frame
 *   counters cleanly.
 *
 * - `budgetCheck(name, ms, budgetMs, now?)` is the shared hook.
 *   Each named budget is rate-limited to a single warning
 *   every 10 s so a sustained budget miss doesn't drown the
 *   console.
 *
 * ## Tree-shaking
 *
 * The monitor itself is imported by `DebugOverlay.tsx`, which
 * is mounted only behind `import.meta.env.DEV`. In a production
 * build the overlay code is dead and Vite strips it. The
 * `budgetCheck` hook is consumed by the (still-pending)
 * perf-instrumentation tasks TASK-30 / TASK-58 / TASK-59 /
 * TASK-61, all of which are themselves dev work — so a
 * production build that ships without those tasks also ships
 * without `frameMonitor` bytes. Today the module is imported
 * only from `DebugOverlay.tsx` + its tests.
 */

/** Minimal logger surface — accepts either the default `console`
 *  bridge or a spy in tests. */
export interface FrameMonitorLogger {
  warn(message: string, ...rest: unknown[]): void;
}

/** A `now` clock — defaults to `performance.now()` in the browser,
 *  injectable in tests for determinism. */
export type ClockFn = () => number;

/** Renderer-side telemetry: a thin slice of `THREE.WebGLRenderer.info`. */
export interface RendererInfo {
  render: { calls: number; triangles: number };
}

/** Default rolling-window capacity in frames. */
export const FRAME_WINDOW_CAPACITY = 300;

/** FPS smoothing window length, ms. */
const FPS_WINDOW_MS = 1000;
/** Budget-warning cooldown so a sustained miss doesn't flood the console. */
const BUDGET_WARN_COOLDOWN_MS = 10_000;

/**
 * Per-frame stats the overlay reads.
 *
 * All percentile fields are over the rolling `FRAME_WINDOW_CAPACITY`
 * frame window (≈ 5 s at 60 fps, ≈ 30 s at 10 fps).
 */
export interface FrameStats {
  /** Smoothed FPS over the most recent 1 s window. */
  fps: number;
  /** Wall-clock duration of the most recent frame, ms. */
  frameTimeMs: number;
  /** Median frame time over the rolling window, ms. */
  p50: number;
  /** 95th-percentile frame time over the rolling window, ms. */
  p95: number;
  /** 99th-percentile frame time over the rolling window, ms. */
  p99: number;
  /** Most recent three.js `renderer.info.render.calls` value. */
  drawCalls: number;
  /** Most recent three.js `renderer.info.render.triangles` value. */
  triangles: number;
  /** Most recent entity count (ships + characters + wrecks rendered). */
  entities: number;
  /** Number of samples currently held in the rolling window. */
  windowSize: number;
}

/** Module-private default logger — silently forwards to `console.warn`
 *  when one exists, swallows logs in non-browser environments so the
 *  module is loadable from Node test harnesses without crashing. */
const consoleLike: FrameMonitorLogger = {
  warn(message: string, ...rest: unknown[]): void {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(message, ...rest);
    }
  },
};

/**
 * In-memory frame monitor.
 *
 * Constructed once per process; the overlay (and any perf
 * instrumentation) reads from it via `getFrameStats()`. The
 * recorder side (`recordFrameTime`, `recordRendererInfo`,
 * `recordEntityCount`) is owned by the render loop driver.
 */
export class FrameMonitor {
  private readonly ring: Float64Array;
  private head = 0;
  /** Number of frames currently in the rolling window (≤ capacity). */
  private filled = 0;

  private lastFrameMs = 0;
  private framesInFpsWindow = 0;
  private lastFpsWindowStartMs = 0;
  private fps = 0;

  private latestDrawCalls = 0;
  private latestTriangles = 0;
  private latestEntities = 0;

  /**
   * Per-category counters — extensible telemetry for non-renderer
   * phases (TASK-26+ uses these to track surface triangles by
   * LOD ring, etc.). Map key is the category name; value is the
   * latest reading. `getCategoryCount(name)` returns the most
   * recent sample or 0.
   */
  private readonly categoryCounts: Map<string, number> = new Map();

  /** Timestamp of the previous `recordFrameTime` sample (monotonic). */
  private prevSampleTs = -1;

  private readonly budgetLastWarnedAt: Map<string, number> = new Map();

  private readonly clock: ClockFn;
  private readonly logger: FrameMonitorLogger;

  constructor(opts: { clock?: ClockFn; logger?: FrameMonitorLogger; capacity?: number } = {}) {
    this.ring = new Float64Array(opts.capacity ?? FRAME_WINDOW_CAPACITY);
    this.clock = opts.clock ?? defaultNow;
    this.logger = opts.logger ?? consoleLike;
  }

  /**
   * Record a frame. Call once per render frame with the wall-clock
   * millisecond timestamp of *this frame's start* (or any monotonic
   * series). The monitor measures the delta against the previous
   * recorded sample; the first frame is recorded as 0 ms (no
   * baseline yet).
   *
   * `now` is the timestamp the caller observed. Pass
   * `performance.now()` in production; pass a fake clock in tests.
   */
  recordFrameTime(now: number): void {
    let delta = 0;
    if (this.prevSampleTs >= 0) {
      delta = now - this.prevSampleTs;
      // Guard against clock anomaly (negative deltas / huge jumps from a
      // tab being backgrounded). Clamp to a sensible upper bound so a
      // single giant frame doesn't poison the rolling percentile.
      if (delta < 0) delta = 0;
      if (delta > 1000) delta = 1000;
    }
    this.prevSampleTs = now;

    this.lastFrameMs = delta;
    this.ring[this.head] = delta;
    this.head = (this.head + 1) % this.ring.length;
    this.filled = Math.min(this.filled + 1, this.ring.length);

    if (this.lastFpsWindowStartMs === 0) {
      this.lastFpsWindowStartMs = now;
    }
    this.framesInFpsWindow += 1;
    const windowElapsed = now - this.lastFpsWindowStartMs;
    if (windowElapsed >= FPS_WINDOW_MS) {
      this.fps = (this.framesInFpsWindow * 1000) / windowElapsed;
      this.lastFpsWindowStartMs = now;
      this.framesInFpsWindow = 0;
    }
  }

  /**
   * Push the most recent renderer info into the monitor. Cheap; two
   * number writes. The caller must invoke this *after*
   * `renderer.render()` so `renderer.info.render` still reflects the
   * frame we just measured.
   */
  recordRendererInfo(info: RendererInfo): void {
    this.latestDrawCalls = info.render.calls;
    this.latestTriangles = info.render.triangles;
  }

  /**
   * Every frame time currently held in the rolling window, oldest
   * first. Off-by-default readers (the TASK-58 benchmark computes
   * percentiles over the whole run rather than the last 300
   * frames) use this; the overlay keeps using `getFrameStats`.
   */
  sampleFrameTimes(): number[] {
    const out: number[] = [];
    const start = (this.head - this.filled + this.ring.length) % this.ring.length;
    for (let i = 0; i < this.filled; i++) {
      out.push(this.ring[(start + i) % this.ring.length]!);
    }
    return out;
  }

  /** Push the active rendered entity count. */
  recordEntityCount(n: number): void {
    this.latestEntities = n;
  }

  /**
   * Record a per-category counter (TASK-26+). Use this for any
   * pipeline phase that wants to surface a number in the debug
   * overlay or feed a budget check: surface triangles per LOD
   * ring, skybox draw calls, particle count, etc. The category
   * name is stable across calls so the overlay can map names
   * to rows.
   */
  recordCategoryCount(name: string, value: number): void {
    this.categoryCounts.set(name, value);
  }

  /** Read the most recent value for a category (0 if absent). */
  getCategoryCount(name: string): number {
    return this.categoryCounts.get(name) ?? 0;
  }

  /** All category names currently tracked (for the overlay). */
  getCategoryNames(): readonly string[] {
    return Array.from(this.categoryCounts.keys()).sort();
  }

  /**
   * Snapshot the rolling-window stats. O(n log n) over the filled
   * region (n ≤ 300). The overlay reads at 2 Hz so the cost is
   * bounded.
   */
  getFrameStats(): FrameStats {
    const sampleSize = this.filled;
    if (sampleSize === 0) {
      return {
        fps: 0,
        frameTimeMs: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        drawCalls: this.latestDrawCalls,
        triangles: this.latestTriangles,
        entities: this.latestEntities,
        windowSize: 0,
      };
    }
    const samples = new Array<number>(sampleSize);
    for (let i = 0; i < sampleSize; i++) {
      samples[i] = this.ring[i]!;
    }
    samples.sort((a, b) => a - b);
    return {
      fps: this.fps,
      frameTimeMs: this.lastFrameMs,
      p50: pickPercentile(samples, 0.5),
      p95: pickPercentile(samples, 0.95),
      p99: pickPercentile(samples, 0.99),
      drawCalls: this.latestDrawCalls,
      triangles: this.latestTriangles,
      entities: this.latestEntities,
      windowSize: sampleSize,
    };
  }

  /**
   * Check whether a measured phase exceeded its budgeted time and
   * emit a rate-limited warning if so.
   *
   * Warning policy: a single `console.warn` per `name` per 10 s so a
   * sustained budget miss doesn't flood the devtools.
   *
   * @param name — stable identifier for the phase (e.g. `"input"`).
   * @param ms — observed duration, ms.
   * @param budgetMs — the threshold; measured `ms > budgetMs` is a miss.
   * @param now — optional override for the wall clock (defaults to
   *              the monitor's injected clock).
   * @returns `true` when `ms > budgetMs`, regardless of whether a
   *          warning was actually emitted (callers commonly want a
   *          miss-flag even when the warning is suppressed by the
   *          cooldown).
   */
  budgetCheck(name: string, ms: number, budgetMs: number, now?: number): boolean {
    const miss = ms > budgetMs;
    if (!miss) return false;
    const ts = now ?? this.clock();
    const lastWarnedAt = this.budgetLastWarnedAt.get(name);
    if (lastWarnedAt !== undefined && ts - lastWarnedAt < BUDGET_WARN_COOLDOWN_MS) {
      return true;
    }
    this.budgetLastWarnedAt.set(name, ts);
    this.logger.warn(
      `[drift-budget] ${name}: ${ms.toFixed(2)}ms exceeds budget ${budgetMs.toFixed(2)}ms`,
    );
    return true;
  }

  /** Reset the rolling window + budget cool-downs. Test-only helper. */
  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.lastFrameMs = 0;
    this.framesInFpsWindow = 0;
    this.lastFpsWindowStartMs = 0;
    this.fps = 0;
    this.latestDrawCalls = 0;
    this.latestTriangles = 0;
    this.latestEntities = 0;
    this.prevSampleTs = -1;
    this.budgetLastWarnedAt.clear();
    this.categoryCounts.clear();
  }
}

/**
 * Pick the linear-interpolated percentile of a sorted-ascending
 * array of numbers. Linear interpolation matches the
 * NumPy-default behaviour so frame-time measurements line up
 * with off-line analysis scripts.
 */
export function pickPercentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const clamped = Math.min(1, Math.max(0, p));
  const rank = clamped * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const weight = rank - lo;
  return sortedAsc[lo]! * (1 - weight) + sortedAsc[hi]! * weight;
}

/** Default clock — prefer `performance.now()` in the browser; fall back to 0. */
function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return 0;
}
