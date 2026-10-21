#!/usr/bin/env tsx
/**
 * Render benchmark CLI — TASK-58.
 *
 * Runs the worst-case scene twice — once through the pre-tuning
 * renderer (`--baseline`) and once through the TASK-58 tuned
 * pipeline — 5 times each, then reports:
 *
 *   - median / p95 / worst frame time per run,
 *   - the number of frames over the 50 ms no-spike threshold,
 *   - peak draw calls, triangles and materials,
 *   - the worst-case frame-time reduction (the ≥ 30 % delta target
 *     that is machine-independent),
 *   - the p95 variance across the 5 runs (repeatability: < 20 %).
 *
 * Usage:
 *
 *   $ npm run bench:render
 *
 * Exit code:
 *   `0` — every tuned budget green, no spikes, variance < 20 %,
 *         and the delta target met.
 *   `1` — a budget miss, a spike, unstable variance, or a delta
 *         below the 30 % target.
 *   `2` — unexpected failure.
 *
 * The absolute frame times are dev-machine numbers; TASK-61 re-runs
 * this script on the reference hardware and re-tunes
 * `src/shared/perf.ts` if the absolute numbers disagree.
 */

import process from "node:process";

import { PERF_PROFILES, variancePct, type PerfProfile } from "../src/shared/perf.js";
import {
  FRAME_TIME_EPSILON_MS,
  runRenderBench,
  SPIKE_THRESHOLD_MS,
  worstCaseReduction,
  type RenderBenchReport,
} from "../src/client/bench/renderBench.js";

/** Runs per configuration (acceptance: 5 runs, p95 variance < 20 %). */
const RUNS = 5;
/** Scene time per run, ms (acceptance: 60 s; the CLI default is 60 s). */
const DURATION_MS = Number.parseInt(process.env.BENCH_RENDER_MS ?? "60000", 10);
/** The delta target the spec measures the tuning against. */
const DELTA_TARGET = 0.3;
/** Repeatability ceiling across the 5 runs. */
const REPEATABILITY_VARIANCE_PCT = 20;

/** One line per run. */
function printRuns(reports: readonly RenderBenchReport[]): void {
  let runIndex = 0;
  // eslint-disable-next-line no-console
  console.log(`\n=== TASK-58 render benchmark (${DURATION_MS / 1000}s per run) ===\n`);
  for (const report of reports) {
    // eslint-disable-next-line no-console
    console.log(
      `[${report.label} run ${runIndex++}] median=${report.medianMs.toFixed(2)}ms ` +
        `p95=${report.p95Ms.toFixed(2)}ms worst=${report.worstMs.toFixed(2)}ms ` +
        `spikes(>${SPIKE_THRESHOLD_MS}ms)=${report.spikes} draws=${report.peakDrawCalls} ` +
        `tris=${report.peakTriangles} materials=${report.peakMaterials} ` +
        `cpu=${report.cpuMs.toFixed(3)}ms budgets=${report.budgetsOk ? "green" : "RED"}`,
    );
    for (const violation of report.violations) {
      // eslint-disable-next-line no-console
      console.log(`    ! ${violation.name}: ${violation.actual} over budget ${violation.budget}`);
    }
  }
}

/** Run one configuration `RUNS` times. */
function runAll(profile: PerfProfile, tuned: boolean, label: string): RenderBenchReport[] {
  const reports: RenderBenchReport[] = [];
  for (let i = 0; i < RUNS; i++) {
    reports.push(runRenderBench({ durationMs: DURATION_MS, profile, tuned, label, seed: i + 1 }));
  }
  return reports;
}

/** Aggregate the 5 runs: the mean run plus the p95 variance. */
function summarise(reports: readonly RenderBenchReport[]): {
  meanMedian: number;
  meanP95: number;
  meanWorst: number;
  spikes: number;
  draws: number;
  tris: number;
  materials: number;
  variancePct: number;
} {
  const mean = (xs: readonly number[]): number =>
    xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return {
    meanMedian: mean(reports.map((r) => r.medianMs)),
    meanP95: mean(reports.map((r) => r.p95Ms)),
    meanWorst: mean(reports.map((r) => r.worstMs)),
    spikes: reports.reduce((a, r) => a + r.spikes, 0),
    draws: Math.max(...reports.map((r) => r.peakDrawCalls)),
    tris: Math.max(...reports.map((r) => r.peakTriangles)),
    materials: Math.max(...reports.map((r) => r.peakMaterials)),
    variancePct: variancePct(reports.map((r) => r.p95Ms)),
  };
}

function main(): void {
  const profile = PERF_PROFILES.high;
  // Warmup: JIT the planner + the scene builder before measuring.
  runRenderBench({ durationMs: 2_000, profile, tuned: true, label: "warmup" });

  const baselineRuns = runAll(profile, false, "baseline");
  const tunedRuns = runAll(profile, true, "tuned");
  printRuns([...baselineRuns, ...tunedRuns]);

  const baseline = summarise(baselineRuns);
  const tuned = summarise(tunedRuns);
  const delta = worstCaseReduction(baselineRuns[0]!, tunedRuns[0]!);

  // eslint-disable-next-line no-console
  console.log("\n--- budgets (worst-case scene, High preset) ---");
  // eslint-disable-next-line no-console
  console.log(
    `tuned:    median=${tuned.meanMedian.toFixed(2)}ms p95=${tuned.meanP95.toFixed(2)}ms ` +
      `worst=${tuned.meanWorst.toFixed(2)}ms spikes=${tuned.spikes} draws=${tuned.draws}/120 ` +
      `tris=${tuned.tris}/500000 materials=${tuned.materials}/40`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `baseline: median=${baseline.meanMedian.toFixed(2)}ms p95=${baseline.meanP95.toFixed(2)}ms ` +
      `worst=${baseline.meanWorst.toFixed(2)}ms spikes=${baseline.spikes} draws=${baseline.draws} ` +
      `tris=${baseline.tris} materials=${baseline.materials}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `delta:    worst-case frame time -${(delta * 100).toFixed(1)}% (target ≥ ${DELTA_TARGET * 100}%)`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `repeatability: tuned p95 variance ${tuned.variancePct.toFixed(2)}% ` +
      `(ceiling ${REPEATABILITY_VARIANCE_PCT}%)`,
  );

  let ok = true;
  const budgetOk = tunedRuns.every((r) => r.budgetsOk);
  if (!budgetOk) {
    console.error("[FAIL] a tuned run exceeded a budget (see the `!` lines above)");
    ok = false;
  }
  if (tuned.spikes > 0) {
    console.error(
      `[FAIL] ${tuned.spikes} frames over the ${SPIKE_THRESHOLD_MS}ms no-spike threshold`,
    );
    ok = false;
  }
  if (tuned.meanP95 > profile.frameBudgetMs + FRAME_TIME_EPSILON_MS) {
    console.error(
      `[FAIL] tuned p95 ${tuned.meanP95.toFixed(2)}ms misses the ${profile.frameBudgetMs}ms budget (tolerance ${FRAME_TIME_EPSILON_MS}ms)`,
    );
    ok = false;
  }
  if (delta < DELTA_TARGET) {
    console.error(
      `[FAIL] worst-case reduction ${(delta * 100).toFixed(1)}% < ${DELTA_TARGET * 100}%`,
    );
    ok = false;
  }
  if (tuned.variancePct >= REPEATABILITY_VARIANCE_PCT) {
    console.error(
      `[FAIL] p95 variance ${tuned.variancePct.toFixed(2)}% is not repeatable (< ${REPEATABILITY_VARIANCE_PCT}%)`,
    );
    ok = false;
  }
  // eslint-disable-next-line no-console
  console.log(
    ok
      ? "\n[ok] every budget green — record these numbers for TASK-61 (reference hardware)."
      : "\n[fail] see the errors above.",
  );
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error("[bench-render] unexpected failure:", err);
  process.exit(2);
}
