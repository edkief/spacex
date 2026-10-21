/**
 * Benchmark collectors for `npm run perf:report` — TASK-61.
 *
 * Each collector runs one *existing* benchmark module (the exact
 * module its owning task ships) and flattens the report into
 * {@link PerfRow}s. Nothing here re-implements a budget: the
 * thresholds are imported from the owning benchmark
 * (`TRANSITION_BUDGET_MS`, `SPIKE_THRESHOLD_MS`,
 * `TICK_BUDGETS`, `LOAD_BUDGETS`) so the report can never drift
 * from the gate that produced it.
 *
 * The collectors are the only part of the perf report that costs
 * wall-clock time; `table.ts` holds the pure formatting.
 */

import os from "node:os";

import { PERF_PROFILES, variancePct, type PerfProfile } from "../../src/shared/perf.js";
import {
  runRenderBench,
  SPIKE_THRESHOLD_MS,
  type RenderBenchReport,
} from "../../src/client/bench/renderBench.js";
import { runTickBench, TICK_BUDGETS } from "../../src/server/bench/tickBench.js";
import {
  NO_PULL_THRESHOLD_MS,
  REPEATABILITY_VARIANCE_PCT,
  TRANSITION_BUDGET_MS,
  runCycle,
  summariseRepeats,
} from "../../src/client/test/transitionCycle.js";
import { runLoadScenario } from "../../tests/load/harness.js";
import { evaluateReport, LOAD_BUDGETS } from "../../tests/load/report.js";
import type { PerfRow } from "./table.js";

/**
 * p95 headroom over the profile's frame budget (1.2x). On `high`
 * that is the acceptance criterion's "p95 <= 20 ms"; on `mobile` it
 * is the 30 fps floor's 40 ms, so the p95 row never contradicts the
 * frame rate the profile is actually held to.
 */
export const RENDER_P95_HEADROOM = 1.2;

/** The p95 budget for a profile, ms. */
export function p95BudgetMs(profile: PerfProfile): number {
  return Math.round(profile.frameBudgetMs * RENDER_P95_HEADROOM * 100) / 100;
}
/** Runs per configuration (the acceptance repeat count). */
export const RENDER_RUNS = 5;
/** Keyboard-loop ceiling: TASK-54's no-dropped-frame rule. */
export const PHONE_LOOP_BUDGET_MS = 100;

/** ms -> `"12.34 ms"`. */
function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}

/** A gate that passes/fails on a boolean, rendered as a row. */
function row(
  benchmark: PerfRow["benchmark"],
  metric: string,
  budget: string,
  measured: string,
  ok: boolean,
): PerfRow {
  return { benchmark, metric, budget, measured, verdict: ok ? "PASS" : "FAIL" };
}

// ---------------------------------------------------------------------------
// TASK-30 — transition hitches
// ---------------------------------------------------------------------------

/** Run the transition cycle `runs` times and flatten the report. */
export function collectTransitionRows(runs = 5): PerfRow[] {
  for (let i = 0; i < 3; i++) runCycle({ repeatIndex: -1 });
  const reports = Array.from({ length: runs }, (_, i) => runCycle({ repeatIndex: i }));
  const summary = summariseRepeats(reports);
  const worstP99 = Math.max(...reports.flatMap((r) => r.phases.map((p) => p.p99DeltaMs)));
  const worstDelta = Math.max(...reports.map((r) => r.worstDeltaMs));
  const longestFrame = Math.max(...reports.map((r) => r.worstFrameMs));
  return [
    row(
      "transitions",
      "per-phase delta, p99",
      `p99 <= ${ms(TRANSITION_BUDGET_MS)}`,
      ms(worstP99),
      reports.every((r) => r.phases.every((p) => p.p99DeltaMs <= TRANSITION_BUDGET_MS)),
    ),
    row(
      "transitions",
      "longest single frame (no-pull)",
      `< ${ms(NO_PULL_THRESHOLD_MS)}`,
      ms(longestFrame),
      reports.every((r) => !r.noPullViolation),
    ),
    row(
      "transitions",
      "worst delta, absolute max",
      `< ${ms(TRANSITION_BUDGET_MS)} (warn-only; GC-sensitive)`,
      ms(worstDelta),
      worstDelta <= TRANSITION_BUDGET_MS,
    ),
    row(
      "transitions",
      "repeatability (per-run p95 frame-cost variance)",
      `< ${REPEATABILITY_VARIANCE_PCT} %`,
      `${summary.variancePct.toFixed(2)} %`,
      summary.stable,
    ),
  ];
}

// ---------------------------------------------------------------------------
// TASK-58 — render benchmark
// ---------------------------------------------------------------------------

/** Mean of a per-run metric across the runs. */
function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

/** Run the worst-case scene `runs` times under one profile. */
export function runProfile(
  profile: PerfProfile,
  durationMs: number,
  runs: number,
  tuned: boolean,
  label: string,
): RenderBenchReport[] {
  return Array.from({ length: runs }, (_, i) =>
    runRenderBench({ durationMs, profile, tuned, label, seed: i + 1 }),
  );
}

/** Flatten `runs` of one profile into the render rows. */
export function renderRows(runs: readonly RenderBenchReport[], profile: PerfProfile): PerfRow[] {
  const median = mean(runs.map((r) => r.medianMs));
  const p95 = mean(runs.map((r) => r.p95Ms));
  const spikes = runs.reduce((a, r) => a + r.spikes, 0);
  const variance = variancePct(runs.map((r) => r.p95Ms));
  const budget = profile.frameBudgetMs;
  const p95Budget = p95BudgetMs(profile);
  return [
    row(
      "render",
      `median frame time (${profile.id} profile, 16-entity worst case)`,
      `<= ${ms(budget)}`,
      ms(median),
      median <= budget,
    ),
    row("render", "p95 frame time", `<= ${ms(p95Budget)}`, ms(p95), p95 <= p95Budget),
    row("render", `frames over ${SPIKE_THRESHOLD_MS} ms`, "0", String(spikes), spikes === 0),
    row(
      "render",
      "peak draw calls",
      `< ${profile.budgets.drawCalls}`,
      String(Math.max(...runs.map((r) => r.peakDrawCalls))),
      runs.every((r) => r.peakDrawCalls < profile.budgets.drawCalls),
    ),
    row(
      "render",
      "peak triangles",
      `< ${profile.budgets.triangles}`,
      String(Math.max(...runs.map((r) => r.peakTriangles))),
      runs.every((r) => r.peakTriangles < profile.budgets.triangles),
    ),
    row(
      "render",
      "peak materials",
      `< ${profile.budgets.materials}`,
      String(Math.max(...runs.map((r) => r.peakMaterials))),
      runs.every((r) => r.peakMaterials < profile.budgets.materials),
    ),
    row(
      "render",
      "p95 repeatability variance",
      `< 20 %`,
      `${variance.toFixed(2)} %`,
      variance < 20,
    ),
  ];
}

// ---------------------------------------------------------------------------
// TASK-60 — server tick
// ---------------------------------------------------------------------------

/** Run the worst-case shard on the real clock and flatten the report. */
export async function collectTickRows(durationMs: number, warmupMs: number): Promise<PerfRow[]> {
  const report = await runTickBench({ durationMs, warmupMs, label: "worst-case" });
  const budgets = new Map(report.budgets.map((b) => [b.name, b.ok]));
  const ok = (name: string): boolean => budgets.get(name) ?? true;
  return [
    row("tick", "tick p50", `< ${ms(TICK_BUDGETS.p50Ms)}`, ms(report.p50Ms), ok("p50 tick")),
    row("tick", "tick p95", `< ${ms(TICK_BUDGETS.p95Ms)}`, ms(report.p95Ms), ok("p95 tick")),
    row("tick", "tick max", `< ${ms(TICK_BUDGETS.maxMs)}`, ms(report.maxMs), ok("max tick")),
    row(
      "tick",
      "effective tick rate",
      `>= ${TICK_BUDGETS.minEffectiveHz} Hz`,
      `${report.effectiveHz.toFixed(2)} Hz`,
      ok("effective Hz"),
    ),
    row(
      "tick",
      "longest catch-up burst",
      `<= ${TICK_BUDGETS.maxCatchupRun} ticks`,
      String(report.maxConsecutiveCatchup),
      ok("consecutive catch-up"),
    ),
    row(
      "tick",
      "heap growth over the window",
      `< ${(TICK_BUDGETS.maxHeapGrowthBytes / 1024 / 1024).toFixed(2)} MB`,
      `${(report.heapGrowthBytes / 1024 / 1024).toFixed(2)} MB`,
      ok("heap growth MB"),
    ),
  ];
}

// ---------------------------------------------------------------------------
// TASK-18 — load smoke
// ---------------------------------------------------------------------------

/** Budget label for one load gate (from `LOAD_BUDGETS`, one source of truth). */
function loadBudget(name: string): string {
  switch (name) {
    case "snapshot-rate":
      return `>= ${LOAD_BUDGETS.minSnapshotHz} Hz`;
    case "no-starvation":
      return `<= ${LOAD_BUDGETS.maxSnapshotGapMs} ms`;
    case "message-size":
      return `< ${LOAD_BUDGETS.maxP95MessageBytes} B`;
    case "rtt":
      return `p95 < ${LOAD_BUDGETS.maxRttP95Ms} ms`;
    case "tick-rate":
      return `>= ${LOAD_BUDGETS.minTickHz} Hz`;
    case "heap-growth":
      return `< ${LOAD_BUDGETS.maxHeapGrowthMb} MB`;
    case "cap-enforcement":
      return `exact ${LOAD_BUDGETS.clientCap} players`;
    default:
      return "must not occur";
  }
}

/** Run the 16-player load smoke and flatten every gate into a row. */
export async function collectLoadRows(durationMs: number): Promise<PerfRow[]> {
  const report = await runLoadScenario({ durationMs, relativeSchedule: true });
  return evaluateReport(report).map((check) =>
    row("load", check.name, loadBudget(check.name), check.detail, check.ok),
  );
}

// ---------------------------------------------------------------------------
// Host facts (recorded so a number is never orphaned from its machine)
// ---------------------------------------------------------------------------

/** Total RAM in GB as reported by the OS (rounded down, 0 when unknown). */
export function hostMemoryGb(): number {
  return Math.floor(os.totalmem() / 1024 ** 3);
}

/** The profile a device tag benchmarks under. */
export function profileForTag(tag: string): PerfProfile {
  return tag === "phone" ? PERF_PROFILES.mobile : PERF_PROFILES.high;
}
