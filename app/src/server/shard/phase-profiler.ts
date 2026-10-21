/**
 * Per-phase tick profiler — TASK-60.
 *
 * The tick histogram (`./histogram.ts`) answers "how long did a
 * tick take"; this module answers "**which part** of the tick took
 * the time". Both are the same instrument at two resolutions: the
 * profiler holds one {@link TickHistogram} per phase and rolls them
 * up into a table the benchmark prints and the tests assert on.
 *
 * Cost when disabled: the sim reads a module-level `null` pointer
 * once per phase per tick (8 reads/tick). No timers, no allocation.
 * When enabled (benchmark, dev profiling) each phase pays two
 * `performance.now()` reads (~50 ns each on V8).
 *
 * The profiler is deliberately **global** rather than a `SimLoop`
 * field: the phases live in five modules (`ai`, `weapons`,
 * `hazards`, `mining`, `entity`) and threading a profiler object
 * through every call signature would touch ~15 files for no
 * benefit. One profiling session = one shard, so a module-level
 * singleton is the right scope.
 */
import { TickHistogram } from "./histogram.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The phases of one simulation step, in execution order. The names
 * are stable — TASK-61's reference-hardware run reads the same
 * table, so renaming one invalidates recorded numbers.
 */
export const TICK_PHASES = [
  "input",
  "integrate",
  "ai",
  "cleanup",
  "projectiles",
  "hazards",
  "mining",
  "snapshot",
  "broadcast",
] as const;

/** Union of the phase names. */
export type TickPhase = (typeof TICK_PHASES)[number];

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** One phase's roll-up over a profiling window. */
export interface PhaseSample {
  /** Phase name. */
  readonly phase: TickPhase;
  /** Median cost per call, ms. */
  readonly p50Ms: number;
  /** 95th-percentile cost per call, ms. */
  readonly p95Ms: number;
  /** Worst single call, ms. */
  readonly maxMs: number;
  /** Sum over the window, ms (the phase's share of tick CPU). */
  readonly totalMs: number;
  /** How many times the phase ran (0 = never ran, e.g. no mining). */
  readonly calls: number;
}

/** The whole tick's roll-up. */
export interface PhaseReport {
  /** Per-phase samples, in {@link TICK_PHASES} order (always present). */
  readonly phases: readonly PhaseSample[];
  /** Sum of every phase's `totalMs` — the measured CPU inside ticks. */
  readonly totalMs: number;
}

// ---------------------------------------------------------------------------
// Profiler
// ---------------------------------------------------------------------------

/**
 * Rolling per-phase cost tracker. One instance per profiling
 * session; `begin` / `end` bracket each phase inside the sim loop.
 *
 * `begin` returns the start timestamp the caller passes straight
 * back to `end`, so the hot path never touches the profiler's
 * internals twice:
 *
 * ```ts
 * const t = profiler?.begin("ai");
 * tickAi({ shard, dt, nowMs });
 * profiler?.end("ai", t);
 * ```
 */
export class PhaseProfiler {
  private readonly histograms = new Map<TickPhase, TickHistogram>();
  private readonly totals = new Map<TickPhase, number>();
  private readonly counts = new Map<TickPhase, number>();

  constructor() {
    for (const phase of TICK_PHASES) {
      this.histograms.set(phase, new TickHistogram());
      this.totals.set(phase, 0);
      this.counts.set(phase, 0);
    }
  }

  /**
   * Open a phase. Returns `performance.now()` for the caller to
   * hand back to {@link PhaseProfiler.end}.
   */
  begin(_phase: TickPhase): number {
    return performance.now();
  }

  /**
   * Close a phase and record its cost. A `start` of `undefined`
   * (profiler attached mid-phase) records nothing.
   */
  end(phase: TickPhase, start: number | undefined): void {
    if (start === undefined) return;
    const elapsed = performance.now() - start;
    this.histograms.get(phase)?.push(elapsed);
    this.totals.set(phase, (this.totals.get(phase) ?? 0) + elapsed);
    this.counts.set(phase, (this.counts.get(phase) ?? 0) + 1);
  }

  /** Roll-up over the window, every phase present in canonical order. */
  report(): PhaseReport {
    const phases: PhaseSample[] = TICK_PHASES.map((phase) => {
      const snap = this.histograms.get(phase)?.snapshot();
      return {
        phase,
        p50Ms: snap?.p50 ?? 0,
        p95Ms: snap?.p95 ?? 0,
        maxMs: snap?.max ?? 0,
        totalMs: this.totals.get(phase) ?? 0,
        calls: this.counts.get(phase) ?? 0,
      };
    });
    return {
      phases,
      totalMs: phases.reduce((sum, p) => sum + p.totalMs, 0),
    };
  }

  /**
   * The three most expensive phases by `totalMs` — the "top-3
   * hotspots" the acceptance criteria require. Ties break in
   * canonical phase order so the list is deterministic.
   */
  topPhases(count = 3): readonly PhaseSample[] {
    return [...this.report().phases]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, count)
      .filter((p) => p.calls > 0);
  }

  /** Drop every sample (a warmup window, or a second scenario). */
  reset(): void {
    for (const phase of TICK_PHASES) {
      this.histograms.get(phase)?.reset();
      this.totals.set(phase, 0);
      this.counts.set(phase, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level handle — the sim's hot path
// ---------------------------------------------------------------------------

let active: PhaseProfiler | null = null;

/**
 * Attach (or detach, with `null`) the profiler the sim loop writes
 * into. The benchmark attaches one for the measurement window and
 * detaches it afterwards; production never attaches one, so the
 * sim's phase bookkeeping stays a pointer read.
 */
export function setTickProfiler(profiler: PhaseProfiler | null): void {
  active = profiler;
}

/** The currently attached profiler, or `null` when profiling is off. */
export function getTickProfiler(): PhaseProfiler | null {
  return active;
}
