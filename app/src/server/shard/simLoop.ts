import type { Timers } from '../timers.ts';

export interface SimLoopOptions {
  /** Fixed step in milliseconds (50 for the 20 Hz sim). */
  tickMs: number;
  /** Most ticks run in one pump; beyond that the backlog is dropped (no spiral of death). */
  maxCatchUp?: number;
  /** Monotonic milliseconds. */
  now: () => number;
  timers: Timers;
  /** Runs one fixed step; `tick` counts from 1. */
  onTick: (tick: number) => void;
}

const HISTORY = 400;

/**
 * Fixed-timestep loop: real time is accumulated and consumed in whole ticks, so the sim never
 * drifts however irregularly the timer fires. After `maxCatchUp` ticks in one pump the remaining
 * backlog is discarded and counted in `droppedMs`. Per-tick durations are kept for p95 reporting.
 */
export class SimLoop {
  tick = 0;
  droppedMs = 0;
  private accumulator = 0;
  private last: number | undefined;
  private handle: unknown;
  private readonly durations: number[] = [];
  private readonly options: Required<SimLoopOptions>;

  constructor(options: SimLoopOptions) {
    this.options = { maxCatchUp: 5, ...options };
  }

  /** Starts pumping on a timer at twice the tick rate (the accumulator absorbs the jitter). */
  start(): void {
    if (this.handle !== undefined) return;
    this.last = this.options.now();
    this.handle = this.options.timers.setInterval(() => this.pump(), this.options.tickMs / 2);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.options.timers.clearInterval(this.handle);
    this.handle = undefined;
    this.last = undefined;
  }

  get running(): boolean {
    return this.handle !== undefined;
  }

  /** Consumes elapsed time in whole ticks. Called by the timer; tests call it directly. */
  pump(): number {
    const { tickMs, maxCatchUp, now, onTick } = this.options;
    const time = now();
    this.accumulator += time - (this.last ?? time);
    this.last = time;
    let ran = 0;
    while (this.accumulator >= tickMs && ran < maxCatchUp) {
      this.accumulator -= tickMs;
      this.tick += 1;
      const started = now();
      onTick(this.tick);
      this.record(now() - started);
      ran += 1;
    }
    if (this.accumulator >= tickMs) {
      const whole = Math.floor(this.accumulator / tickMs) * tickMs;
      this.droppedMs += whole;
      this.accumulator -= whole;
    }
    return ran;
  }

  private record(ms: number): void {
    this.durations.push(ms);
    if (this.durations.length > HISTORY) this.durations.shift();
  }

  /** Tick duration at percentile `p` (0..1) over the recent history, in milliseconds. */
  percentile(p: number): number {
    if (this.durations.length === 0) return 0;
    const sorted = [...this.durations].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
  }
}
