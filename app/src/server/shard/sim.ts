/**
 * Fixed-timestep simulation loop (TASK-13).
 *
 * Runs an `onTick` callback at a fixed period (20 Hz for the shard: 50 ms)
 * using a setTimeout CHAIN (no setInterval) with drift correction: the ideal
 * tick times are tracked independently of when the timer actually fires, so
 * timer jitter never accumulates into drift.
 *
 * Anti spiral-of-death: if the event loop stalled and N ticks are owed, at
 * most `maxCatchUpTicks` (default 5) are simulated in one burst; the rest of
 * the owed time is skipped. While a burst had to skip ticks, new client
 * inputs are dropped (they would integrate one tick late and reconcile to
 * the dropped state anyway) — see `inputDrops`.
 */

export interface SimLoopOptions {
  /** Tick period in milliseconds (50 = 20 Hz). */
  dtMs: number;
  /** Max ticks simulated per burst before the rest is skipped (default 5). */
  maxCatchUpTicks?: number;
  onTick: (tick: number) => void;
  /** Injectable clock (tests use fake timers, which patch Date.now). */
  now?: () => number;
}

export class SimLoop {
  private readonly dtMs: number;
  private readonly maxCatchUp: number;
  private readonly onTick: (tick: number) => void;
  private readonly now: () => number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Ideal time (ms) of the next tick — drift correction anchor. */
  private nextTickAt = 0;
  private dropping = false;

  /** 1-based count of ticks that have run (survives stop/start). */
  tickNumber = 0;

  constructor(options: SimLoopOptions) {
    this.dtMs = options.dtMs;
    this.maxCatchUp = options.maxCatchUpTicks ?? 5;
    this.onTick = options.onTick;
    this.now = options.now ?? (() => Date.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * True right after a burst that had to skip ticks: enqueueInput should drop
   * new inputs until the loop is on-time again (cleared by the next burst
   * that simulated everything it owed).
   */
  get inputDrops(): boolean {
    return this.dropping;
  }

  /**
   * Accumulator core: simulate every tick owed at wall-clock time `t`,
   * capped at maxCatchUpTicks per burst (the rest is skipped — spiral-of-
   * death protection). Returns the number of ticks run. Exposed publicly so
   * the accumulator math is unit-testable without a real event-loop stall.
   */
  step(t: number): number {
    const owed = t >= this.nextTickAt ? Math.floor((t - this.nextTickAt) / this.dtMs) + 1 : 0;
    const run = Math.min(owed, this.maxCatchUp);
    this.dropping = owed > run;
    for (let i = 0; i < run; i++) {
      this.tickNumber += 1;
      this.onTick(this.tickNumber);
    }
    // Skip the un-simulated owed time so the loop never spirals.
    this.nextTickAt += owed * this.dtMs;
    return run;
  }

  /** Start ticking; the first tick fires one dtMs later. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.dropping = false;
    this.nextTickAt = this.now() + this.dtMs;
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.dropping = false;
  }

  private schedule(): void {
    const delay = Math.max(0, this.nextTickAt - this.now());
    this.timer = setTimeout(() => this.fire(), delay);
  }

  private fire(): void {
    this.timer = null;
    if (!this.running) return;
    this.step(this.now());
    this.schedule();
  }
}
