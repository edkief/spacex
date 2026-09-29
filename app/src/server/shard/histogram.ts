/**
 * Ring-buffer tick-duration histogram (TASK-13). The shard records each tick's
 * wall-clock duration here so the tick budget (p95 < 30 ms, TASK-60) is
 * observable in-process; capacity covers several seconds of ticks.
 */
export class TickHistogram {
  private readonly capacity: number;
  private readonly buf: number[];
  private head = 0;
  private count = 0;

  constructor(capacity = 2048) {
    this.capacity = capacity;
    this.buf = new Array<number>(capacity).fill(0);
  }

  record(ms: number): void {
    this.buf[this.head] = ms;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  get sampleCount(): number {
    return this.count;
  }

  /**
   * p-th percentile (p in 0..1, e.g. 0.95) of the recorded durations, in ms.
   * Nearest-rank on the current window; 0 when empty.
   */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const copy = this.buf.slice(0, this.count).sort((a, b) => a - b);
    const rank = Math.min(this.count - 1, Math.max(0, Math.ceil(p * this.count) - 1));
    return copy[rank];
  }

  /** Min/max of the recorded window (sanity checks in tests). */
  range(): { min: number; max: number } {
    if (this.count === 0) return { min: 0, max: 0 };
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const v = this.buf[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }
}
