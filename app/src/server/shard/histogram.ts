/**
 * Ring-buffer histogram for sim tick durations — TASK-13.
 *
 * We track the last N tick durations in a fixed-size array (default
 * 1024) and expose O(n) `percentile(p)` queries over the window.
 *
 * Why a ring buffer instead of a fixed array of sorts or a
 * reservoir sample?
 *
 *   - The tick metrics are *local*: the operator cares about
 *     "right now", not "right now blended with two hours ago". A
 *     ring buffer of recent ticks answers that with one renderable
 *     number per query.
 *   - Implementation is short and dependency-free. The alternative
 *     (hdr-histogram-js) adds an npm dependency for ~60 lines of
 *     arithmetic, and we're targeting Node 22 with `noUnusedLocals`.
 *   - `percentile(95)` is exact: it sorts a window of ≤1024 samples
 *     every time it's called. A 16-ship sim produces ~20 ticks/sec
 *     → 1024 ticks ≈ 51 s of recent history. Plenty enough for the
 *     p95 budget check (30 ms at 16 ships, runtime budget).
 *
 * The buffer fills monotonically until `head === capacity`, then
 * wraps. `percentile` walks every entry — O(N) over the window is
 * fine for the call frequency (once per `stats()` read, which is
 * dominated by tests + dev tooling).
 */

export interface HistogramStats {
  /** Number of samples stored. Caps at `capacity`. */
  readonly count: number;
  /** Most recent sample (ms). */
  readonly latest: number;
  /** Median (p50, ms). */
  readonly p50: number;
  /** p95 (ms). */
  readonly p95: number;
  /** p99 (ms). */
  readonly p99: number;
  /** Maximum sample in the current window (ms). */
  readonly max: number;
}

/**
 * Construction-time capacity. 1024 samples = ~51 s at 20 Hz; long
 * enough for trend spotting, short enough that `percentile(99)`
 * stays cheap.
 */
export const DEFAULT_CAPACITY = 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class TickHistogram {
  private readonly buffer: Float64Array;
  private readonly capacity: number;
  /** Next write index. Wraps once `head === capacity`. */
  private head = 0;
  /** Number of samples written (caps at `capacity`). */
  private size = 0;
  /** Number of times we pushed a non-finite / negative sample; for tests. */
  private rejected = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`TickHistogram: capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buffer = new Float64Array(capacity);
  }

  /** Push one duration sample (ms). Negative / non-finite values are rejected. */
  push(sampleMs: number): void {
    if (!Number.isFinite(sampleMs) || sampleMs < 0) {
      this.rejected += 1;
      return;
    }
    this.buffer[this.head] = sampleMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /** Current window's stats. Returns zeros if no samples have been pushed. */
  snapshot(): HistogramStats {
    if (this.size === 0) {
      return { count: 0, latest: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }
    // Copy the active window into a plain array, sort, and pluck
    // percentiles. `Float64Array` sort is in place, but mutating
    // the ring buffer would corrupt subsequent reads — copy first.
    const window = new Float64Array(this.size);
    for (let i = 0; i < this.size; i++) window[i] = this.buffer[i] as number;
    // Numeric sort; Float64Array.sort defaults to numeric.
    const sorted = Array.from(window).sort((a, b) => a - b);
    return {
      count: this.size,
      latest: sorted[sorted.length - 1] ?? 0,
      p50: pick(sorted, 0.5),
      p95: pick(sorted, 0.95),
      p99: pick(sorted, 0.99),
      max: sorted[sorted.length - 1] ?? 0,
    };
  }

  /** Test-only: how many rejections so far. */
  get rejectedCount(): number {
    return this.rejected;
  }

  /** Test-only: how many slots are filled. */
  get sizeForTesting(): number {
    return this.size;
  }

  /** Test-only: window capacity. */
  get capacityValue(): number {
    return this.capacity;
  }

  /** Clear every sample. */
  reset(): void {
    this.head = 0;
    this.size = 0;
    this.buffer.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick the `q`-quantile (0..1) of a sorted array using the
 * nearest-rank method. `q=0.5` returns the median for even-length
 * arrays by averaging the two middle values; `q=0.95` returns the
 * 95th percentile.
 */
function pick(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (q <= 0) return sorted[0] ?? 0;
  if (q >= 1) return sorted[sorted.length - 1] ?? 0;
  const rank = q * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo] ?? 0;
  const frac = rank - lo;
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * frac;
}
