#!/usr/bin/env tsx
/**
 * Server tick benchmark CLI — TASK-60.
 *
 * Runs the worst-case shard (16 player connections + 10 engaged AI +
 * a 16-missile volley + 20 ground items + 30 deposits + 8 hazard
 * cells) through the **real** `SimLoop` on the **real** wall clock,
 * then reports:
 *
 *   - the tick histogram (p50 / p95 / max),
 *   - the effective tick rate + the longest catch-up burst run,
 *   - the per-phase cost table with the top-3 hotspots called out,
 *   - heap growth across the run (after a forced GC),
 *   - the budget verdict.
 *
 * Usage:
 *
 *   $ npm run bench:tick                  # 120 s run (acceptance)
 *   $ BENCH_TICK_MS=10000 npm run bench:tick
 *   $ npm run bench:tick -- --expose-gc   # exact heap-growth number
 *
 * Exit code:
 *   `0` — every budget green.
 *   `1` — a budget was missed (the report prints the culprit).
 *   `2` — the run itself failed.
 *
 * The absolute milliseconds are dev-machine numbers; TASK-61
 * re-runs this script on the reference hardware. `npm run
 * bench:tick -- --expose-gc` is what produces the memory number the
 * < 20 MB criterion is measured against.
 */

import process from "node:process";

import { runTickBench, TICK_BUDGETS, type TickBenchReport } from "../src/server/bench/tickBench.js";

/** Measured window, ms. The acceptance criterion is 120 s. */
const DURATION_MS = Number.parseInt(process.env.BENCH_TICK_MS ?? "120000", 10);
/** Warmup before the measurement window, ms. */
const WARMUP_MS = Number.parseInt(process.env.BENCH_TICK_WARMUP_MS ?? "5000", 10);

/** Print the whole report. */
function printReport(report: TickBenchReport): void {
  // eslint-disable-next-line no-console
  console.log(
    `\n=== TASK-60 server tick benchmark (${(report.durationMs / 1000).toFixed(1)}s) ===\n`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `ticks=${report.ticks} wakeups=${report.tickCalls} effectiveHz=${report.effectiveHz.toFixed(2)} ` +
      `maxConsecutiveCatchup=${report.maxConsecutiveCatchup}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `tick: p50=${report.p50Ms.toFixed(2)}ms p95=${report.p95Ms.toFixed(2)}ms ` +
      `max=${report.maxMs.toFixed(2)}ms`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `heap: growth=${(report.heapGrowthBytes / 1024 / 1024).toFixed(2)}MB ` +
      `live=${(report.heapUsedBytes / 1024 / 1024).toFixed(2)}MB ` +
      `peakRss=${(report.peakRssBytes / 1024 / 1024).toFixed(2)}MB`,
  );
  // eslint-disable-next-line no-console
  console.log(`\nper-phase cost (${report.phases.length} phases, hottest first):`);
  // eslint-disable-next-line no-console
  console.log("  phase          calls      p50        p95        max      total");
  for (const phase of report.phases) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${phase.phase.padEnd(12)} ${String(phase.calls).padStart(6)}` +
        `${phase.p50Ms.toFixed(4).padStart(10)}ms${phase.p95Ms.toFixed(4).padStart(10)}ms` +
        `${phase.maxMs.toFixed(3).padStart(9)}ms${phase.totalMs.toFixed(1).padStart(9)}ms`,
    );
  }
  const top3 = report.phases.slice(0, 3);
  // eslint-disable-next-line no-console
  console.log(
    `\ntop-3 hotspots: ${top3.map((p) => `${p.phase} (${p.totalMs.toFixed(0)}ms)`).join(", ")}`,
  );
  // eslint-disable-next-line no-console
  console.log(`missile volley fired: ${report.missileVolleyFired} weapons`);
  // eslint-disable-next-line no-console
  console.log("\nbudgets:");
  for (const line of report.budgets) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${line.ok ? "PASS" : "FAIL"}  ${line.name}: ${formatBudgetValue(line.name, line.actual)} ` +
        `(limit ${formatBudgetValue(line.name, line.budget)})`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nverdict: ${report.ok ? "GREEN" : "RED"}\n`);
}

/** MB for the heap line, plain numbers elsewhere. */
function formatBudgetValue(name: string, value: number): string {
  return name.endsWith("MB") ? `${(value / 1024 / 1024).toFixed(2)}MB` : value.toFixed(2);
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    `drift tick bench — ${DURATION_MS / 1000}s window, ${WARMUP_MS / 1000}s warmup, ` +
      `budgets p50<${TICK_BUDGETS.p50Ms}ms p95<${TICK_BUDGETS.p95Ms}ms max<${TICK_BUDGETS.maxMs}ms ` +
      `rate>=${TICK_BUDGETS.minEffectiveHz}Hz`,
  );
  const report = await runTickBench({
    durationMs: DURATION_MS,
    warmupMs: WARMUP_MS,
    label: "worst-case",
  });
  printReport(report);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("tick bench failed:", error);
  process.exit(2);
});
