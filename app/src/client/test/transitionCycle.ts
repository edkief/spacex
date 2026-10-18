/**
 * Transition-cycle benchmark driver — TASK-30.
 *
 * The spec's acceptance criterion: "every seamless transition (space
 * to atmosphere, atmosphere to surface, disembark, re-enter) costs
 * no more than 4 ms of frame time on the reference client, with no
 * visible pop or cut."
 *
 * This module is the dev-only scripted-cycle harness that walks the
 * player through the full transition path:
 *
 *   space → atmosphere → surface on pad → disembark → walk 10 m →
 *   re-enter → atmosphere → space
 *
 * Every frame is measured against the **idle baseline** (the same
 * scene with no transitions active) so the budget assertion is on
 * the *delta* — the spec's "transition adds < 4 ms" rule, not an
 * absolute 4 ms ceiling (which would conflate dev-machine slowness
 * with regression).
 *
 * ## Module layout
 *
 *   - `transitionCycle.ts`         — the driver (`runCycle` + types)
 *   - `transitionCycle.types.ts`   — public type surface
 *   - `transitionCycle.constants.ts` — public constants
 *   - `transitionCycle.phases.ts`  — per-phase setup + work callbacks
 *   - `transitionCycle.baseline.ts` — `measureBaseline`
 *   - `transitionCycle.warmup.ts`  — JIT + chunk pre-warm
 *   - `transitionCycle.helpers.ts` — fixtures + percentile + clock
 *
 * ## Phases
 *
 * Each phase is a `(setup, work, teardown)` triple the driver runs
 * for `frames` simulated render frames. The `FrameMonitor` is wired
 * into each phase's `budgetCheck` so any over-budget call emits the
 * rate-limited `console.warn` the rest of the perf surface uses.
 *
 * ## Repeatability
 *
 * The full bench (`scripts/bench-transitions.ts`) runs the cycle
 * 5 times and asserts the per-run worst-delta variance is below
 * 20 %. The fast CI version (`transitionCycle.test.ts`) runs a
 * single cycle and only asserts the budget; the variance check
 * belongs to the long-form bench so the unit suite stays under
 * its 60-second wall-clock budget.
 *
 * ## Tree-shaking
 *
 * This module is dev-only. It is imported by the bench script
 * (`scripts/bench-transitions.ts`) and the test suite
 * (`transitionCycle.test.ts`); production builds do not import
 * either entry point so the bundle is unaffected.
 *
 * @see ../perf/frameMonitor.ts — the underlying timing primitive.
 * @see ../../../scripts/bench-transitions.ts — the bench CLI.
 * @see ./transitionCycle.test.ts — the CI smoke test.
 */

import { IDENTITY } from "@shared/physics/vec.js";

import { FrameMonitor } from "../perf/frameMonitor.js";
import { ChunkPipeline } from "../world/pipeline.js";
import { CameraRig } from "../camera/CameraRig.js";

import { measureBaseline } from "./transitionCycle.baseline.js";
import {
  PHASE_FRAMES_DEFAULT,
  TRANSITION_BUDGET_MS,
  NO_PULL_THRESHOLD_MS,
} from "./transitionCycle.constants.js";
import { defaultClock, pickPercentile, resolveFixtures } from "./transitionCycle.helpers.js";
import { PHASES } from "./transitionCycle.phases.js";
import { runCycleWarmup } from "./transitionCycle.warmup.js";
import type {
  CycleReport,
  CycleState,
  PhaseFrame,
  PhaseName,
  PhaseReport,
  PhaseWork,
  RunCycleOptions,
} from "./transitionCycle.types.js";

export { PHASE_ORDER } from "./transitionCycle.types.js";
export type { CycleReport, PhaseName, PhaseReport, PhaseFrame } from "./transitionCycle.types.js";
export {
  TRANSITION_BUDGET_MS,
  NO_PULL_THRESHOLD_MS,
  REPEATABILITY_VARIANCE_PCT,
  BASELINE_FRAMES,
  PHASE_FRAMES_DEFAULT,
  SIM_DT_S,
} from "./transitionCycle.constants.js";

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Run the full transition cycle once. Returns a `CycleReport` the
 * caller can assert against (the test suite) or stringify (the
 * bench script).
 *
 * The driver is deterministic for a given `(seed, clock)` pair —
 * the `FrameMonitor` uses the injected clock, the physics is pure,
 * and the only nondeterminism is wall-clock measurement.
 *
 * `framesPerPhase` defaults to `PHASE_FRAMES_DEFAULT`. The CI
 * version passes a smaller value (e.g. 20) so the suite stays
 * under its 60-second budget; the bench script uses the default.
 */
export function runCycle(opts: RunCycleOptions = {}): CycleReport {
  const framesPerPhase = opts.framesPerPhase ?? PHASE_FRAMES_DEFAULT;
  const seed = opts.seed ?? "transition-cycle-bench";
  const clock: () => number = opts.clock ?? defaultClock;
  const fx = resolveFixtures(seed);

  const state = buildCycleState(seed, fx, clock, opts.logger);
  if (!opts.skipWarmup) {
    runCycleWarmup(state);
  }
  const baseline = opts.skipBaseline ? { meanMs: 0, p95Ms: 0 } : measureBaseline({ state });
  const phaseReports = runCyclePhases(state, framesPerPhase, baseline, clock);

  return aggregateCycleReport(seed, phaseReports, baseline, opts.repeatIndex ?? 0);
}

// ---------------------------------------------------------------------------
// State construction
// ---------------------------------------------------------------------------

/**
 * Construct the simulation state shared across the cycle. The
 * fixtures come from `resolveFixtures`; the rig + pipeline are
 * wired up with the spec's 4 ms budget.
 */
function buildCycleState(
  seed: string,
  fx: ReturnType<typeof resolveFixtures>,
  clock: () => number,
  logger: RunCycleOptions["logger"],
): CycleState {
  const monitor = new FrameMonitor({ clock, logger });
  const pipeline = new ChunkPipeline({
    seed,
    planet: fx.planet,
    budgetMs: 4, // real per-frame budget (the spec's 4 ms cap)
  });
  const rig = new CameraRig({
    aspect: 16 / 9,
    heightAt: fx.planetContext.heightAt,
    planetCenter: fx.planetContext.center,
  });
  return {
    seed,
    starId: fx.starId,
    planet: fx.planet,
    planetContext: fx.planetContext,
    planetAtmosphere: fx.planetAtmosphere,
    pad: fx.pad,
    planetCenter: fx.planetCenter,
    planets: [fx.planetContext],
    monitor,
    pipeline,
    rig,
    ship: {
      pos: {
        x: fx.planetCenter.x + 1_000_000,
        y: fx.planetCenter.y,
        z: fx.planetCenter.z,
      },
      vel: { x: 0, y: 0, z: 0 },
      quat: IDENTITY,
      regime: "space",
    },
    character: null,
    cameraCharacter: null,
    regime: "space",
    prevRegime: "space",
    cameraMode: "cockpit",
    walkDistanceM: 0,
    clock,
  };
}

// ---------------------------------------------------------------------------
// Phase execution
// ---------------------------------------------------------------------------

/**
 * Walk the cycle through every phase, measuring per-frame cost.
 * Returns the per-phase reports in `PHASE_ORDER`. The caller
 * aggregates into the final `CycleReport` shape.
 */
function runCyclePhases(
  state: CycleState,
  framesPerPhase: number,
  baseline: { meanMs: number; p95Ms: number },
  clock: () => number,
): PhaseReport[] {
  const phaseReports: PhaseReport[] = [];
  for (const [phaseName, work] of PHASES) {
    const frames = runPhaseFrames(state, work, framesPerPhase, phaseName, baseline, clock);
    const report = aggregatePhase(phaseName, frames);
    phaseReports.push(report);
  }
  return phaseReports;
}

/** Measure every frame in a single phase. */
function runPhaseFrames(
  state: CycleState,
  work: PhaseWork,
  framesPerPhase: number,
  phaseName: PhaseName,
  baseline: { meanMs: number; p95Ms: number },
  clock: () => number,
): PhaseFrame[] {
  const frames: PhaseFrame[] = [];
  work.setup(state);
  const framesThisPhase = Math.min(framesPerPhase, work.frames);
  for (let i = 0; i < framesThisPhase; i++) {
    const t0 = clock();
    work.work(state);
    const t1 = clock();
    const measuredMs = t1 - t0;
    const deltaMs = measuredMs - baseline.meanMs;
    // Use the FrameMonitor's budgetCheck so any over-budget
    // phase emits the rate-limited warn the rest of the perf
    // surface uses.
    state.monitor.budgetCheck(phaseName, deltaMs, TRANSITION_BUDGET_MS, t1);
    frames.push({
      transition: phaseName,
      frameIndex: i,
      baselineMs: baseline.meanMs,
      measuredMs,
      deltaMs,
      noPullViolation: measuredMs > NO_PULL_THRESHOLD_MS,
    });
  }
  work.teardown?.(state);
  return frames;
}

/** Compute the worst / p99 delta + the worst frame for one phase. */
function aggregatePhase(transition: PhaseName, frames: readonly PhaseFrame[]): PhaseReport {
  let worstFrame = frames[0]!;
  for (const frame of frames) {
    if (frame.deltaMs > worstFrame.deltaMs) worstFrame = frame;
  }
  const deltas = frames.map((f) => f.deltaMs).sort((a, b) => a - b);
  const p99DeltaMs = pickPercentile(deltas, 0.99);
  return { transition, frames, worstDeltaMs: worstFrame.deltaMs, worstFrame, p99DeltaMs };
}

/** Roll the per-phase reports into the cycle-level `CycleReport`. */
function aggregateCycleReport(
  _seed: string,
  phaseReports: readonly PhaseReport[],
  baseline: { meanMs: number; p95Ms: number },
  repeatIndex: number,
): CycleReport {
  let worstFrameMs = 0;
  let worstPhase: PhaseName = "space-idle";
  let worstDeltaMs = 0;
  let noPullViolation = false;
  let totalFrames = 0;
  for (const report of phaseReports) {
    for (const frame of report.frames) {
      if (frame.measuredMs > worstFrameMs) worstFrameMs = frame.measuredMs;
      if (frame.noPullViolation) noPullViolation = true;
      totalFrames += 1;
    }
    if (report.worstDeltaMs > worstDeltaMs) {
      worstDeltaMs = report.worstDeltaMs;
      worstPhase = report.transition;
    }
  }
  return {
    baselineMeanMs: baseline.meanMs,
    baselineP95Ms: baseline.p95Ms,
    phases: phaseReports,
    worstDeltaMs,
    worstPhase,
    worstFrameMs,
    noPullViolation,
    perPhaseWorstDeltaMs: phaseReports.map((r) => r.worstDeltaMs),
    totalFrames,
    repeatIndex,
  };
}

// ---------------------------------------------------------------------------
// Repeatability check
// ---------------------------------------------------------------------------

/**
 * Variance over an array of per-run worst-delta numbers, expressed
 * as a percentage of the mean. Returns `0` for an empty array or
 * a zero-mean array (nothing to compare against).
 */
export function variancePct(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  const stddev = Math.sqrt(variance);
  return (stddev / mean) * 100;
}

/**
 * Aggregate a list of `CycleReport`s into a repeatability summary
 * the bench script prints. The shape mirrors the spec: "p95 of the
 * per-run worst delta is stable (variance < 20 %)".
 */
export interface RepeatabilitySummary {
  readonly reports: readonly CycleReport[];
  readonly worstDeltaPerRun: readonly number[];
  readonly p95OfWorstDeltas: number;
  readonly variancePct: number;
  readonly stable: boolean;
}

export function summariseRepeats(reports: readonly CycleReport[]): RepeatabilitySummary {
  const worstDeltaPerRun = reports.map((r) => r.worstDeltaMs);
  const sorted = [...worstDeltaPerRun].sort((a, b) => a - b);
  const p95OfWorstDeltas = pickPercentile(sorted, 0.95);
  const variance = variancePct(worstDeltaPerRun);
  return {
    reports,
    worstDeltaPerRun,
    p95OfWorstDeltas,
    variancePct: variance,
    stable: variance < 20,
  };
}
