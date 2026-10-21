#!/usr/bin/env tsx
/**
 * Reference-hardware perf report CLI — TASK-61.
 *
 * One command, one device, one table:
 *
 *   $ npm run perf:report desktop      # High preset, 16-entity worst case
 *   $ npm run perf:report phone        # Mobile profile, reduced scene
 *
 * It runs the four acceptance benchmarks — transitions (TASK-30),
 * render (TASK-58), tick (TASK-60) and the 16-player load smoke
 * (TASK-18) — imports the reports, prints the table
 * `docs/performance.md` carries, and writes the same data as JSON
 * to `app/data/perf-report-<tag>.json`. The phone run additionally
 * drives the keyboard-only loop (TASK-54) over ADB / a Chrome
 * remote-debugging endpoint; without a device attached it writes a
 * BLOCKED-PENDING-DEVICE note instead of inventing numbers.
 *
 * Usage:
 *
 *   $ npm run perf:report <desktop|phone> --bench=render,tick [--label="Pixel 7a"]
 *   $ PERF_RENDER_MS=20000 npm run perf:report desktop   # shorter window
 *
 * Exit codes:
 *   `0` — every row PASS.
 *   `1` — at least one row FAIL (the owning task is re-opened).
 *   `2` — the run itself failed.
 *   `3` — BLOCKED: a device the criteria need was not attached.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  collectLoadRows,
  collectTickRows,
  collectTransitionRows,
  hostMemoryGb,
  profileForTag,
  renderRows,
  runProfile,
  p95BudgetMs,
  PHONE_LOOP_BUDGET_MS,
} from "./perf-report/collect.js";
import {
  BENCHMARK_LABELS,
  criterionVerdict,
  failuresByOwner,
  formatBlockedNote,
  formatDeviceHeader,
  formatTable,
  type BenchmarkId,
  type DeviceInfo,
  type PerfRow,
  type SuiteResult,
} from "./perf-report/table.js";

/** Wall-clock budgets. The defaults are the acceptance windows. */
const RENDER_MS = Number.parseInt(process.env.PERF_RENDER_MS ?? "60000", 10);
const TICK_MS = Number.parseInt(process.env.PERF_TICK_MS ?? "120000", 10);
const LOAD_MS = Number.parseInt(process.env.PERF_LOAD_MS ?? "30000", 10);
const RENDER_RUNS = 5;
const TRANSITION_RUNS = 5;

/** The ADB endpoint used to reach a USB-attached Android device. */
const PHONE_CDP_ENV = "PERF_PHONE_CDP";

/**
 * Is a phone reachable at all? Either the operator exported a
 * Chrome remote-debugging endpoint, or ADB lists an attached
 * device. Anything else means SC-4 cannot be measured here and the
 * honest outcome is the BLOCKED-PENDING-DEVICE note.
 */
function phoneAttached(): boolean {
  if (process.env[PHONE_CDP_ENV]) return true;
  try {
    const out = execFileSync("adb", ["devices"], { encoding: "utf8" });
    return out
      .split("\n")
      .slice(1)
      .some((line) => line.trim().endsWith("\tdevice"));
  } catch {
    return false;
  }
}

/**
 * Run the keyboard-only loop with the Mobile profile forced
 * (TASK-54 + TASK-59's e2e). The verdict is the specs' exit code:
 * the loop must boot, fly, target, fire and warp with zero console
 * errors on a phone-sized screen. The "> 100 ms dropped frame" half
 * of the criterion is covered by the render rows above — a frame
 * over 100 ms is also a frame over the 50 ms spike threshold, so a
 * zero-spike Mobile run cannot hide one.
 */
function phoneLoopRows(): PerfRow[] {
  try {
    execFileSync(
      "npx",
      ["playwright", "test", "tests/e2e/keyboardOnly.spec.ts", "tests/e2e/mobileProfile.spec.ts"],
      { stdio: "inherit", env: process.env },
    );
    return [
      {
        benchmark: "phone-loop",
        metric: "keyboard-only loop, Mobile profile forced (boot -> fly -> target -> fire -> warp)",
        budget: `no dropped frame > ${PHONE_LOOP_BUDGET_MS} ms; no console errors`,
        measured: "specs green on the attached device",
        verdict: "PASS",
      },
    ];
  } catch {
    return [
      {
        benchmark: "phone-loop",
        metric: "keyboard-only loop, Mobile profile forced",
        budget: `no dropped frame > ${PHONE_LOOP_BUDGET_MS} ms; no console errors`,
        measured: "playwright run exited non-zero",
        verdict: "FAIL",
      },
    ];
  }
}

/**
 * `--flag=value` / positional arguments from argv. The subset flag is
 * `--bench`, **not** `--only`: npm itself owns `--only` (it filters
 * workspaces) and swallows it before the script ever sees it.
 */
function parseArgs(argv: readonly string[]): {
  tag: string;
  bench: readonly BenchmarkId[] | null;
  label: string | null;
} {
  const tag = argv.find((a) => !a.startsWith("--")) ?? "desktop";
  const bench = argv.find((a) => a.startsWith("--bench="));
  return {
    tag,
    bench: bench
      ? bench
          .slice("--bench=".length)
          .split(",")
          .map((s) => s.trim() as BenchmarkId)
      : null,
    label: argv.find((a) => a.startsWith("--label="))?.slice("--label=".length) ?? null,
  };
}

/** The current short git sha, or `"unknown"` outside a repo. */
function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: path.join(import.meta.dirname, "..", ".."),
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * A `Linux 5.10 … aarch64` kernel line says nothing useful about
 * the class of hardware; the CPU model does. Read it, else fall
 * back to the platform + core count so the field is never empty.
 */
function describeCpu(): string {
  try {
    const cpus = os.cpus();
    const model = cpus[0]?.model.replace(/\s+/g, " ").trim();
    const cores = cpus.length;
    return model ? `${model} (${cores} vCPU)` : `${os.platform()} ${os.arch()} (${cores} vCPU)`;
  } catch {
    return `${os.platform()} ${os.arch()}`;
  }
}

/**
 * Build the device block. Headless CI has no GPU at all, which is
 * itself a reportable fact — the note says so rather than
 * implying a real GPU was measured.
 */
function describeDevice(tag: string, label: string | null): DeviceInfo {
  const isPhone = tag === "phone";
  return {
    tag,
    kind: isPhone ? "phone" : "desktop",
    label: label ?? (isPhone ? "unattached phone" : "dev container (headless)"),
    cpu: describeCpu(),
    memoryGb: hostMemoryGb(),
    os: `${os.type()} ${os.release()}`,
    gpu: "none (software rasteriser; benchmarks are headless cost models)",
    note: isPhone
      ? "No phone attached; see the BLOCKED-PENDING-DEVICE section."
      : "Container on emulated aarch64 — NOT the reference desktop class (see docs/performance.md).",
  };
}

/** Commands a human runs on real hardware to reproduce the run. */
function reproduceCommands(tag: string): string[] {
  return [
    "# 1. attach the device and confirm it is visible",
    "adb devices -l                       # Android over USB",
    "",
    "# 2. run the suite (this is the whole human step)",
    `npm run perf:report ${tag}`,
    "",
    "# Android: Chrome remote debugging (device must have USB debugging on)",
    "adb forward tcp:9222 localabstract:chrome_devtools_remote",
    `PERF_PHONE_CDP=http://localhost:9222 npm run perf:report ${tag}`,
    "",
    "# Android: on-device keyboard-only loop (no desktop browser at all)",
    "adb shell input keyevent 82                          # wake + unlock",
    "npx playwright test tests/e2e/keyboardOnly.spec.ts tests/e2e/mobileProfile.spec.ts",
    "",
    "# shorter windows while iterating (numbers are NOT acceptance-grade)",
    "PERF_RENDER_MS=20000 PERF_TICK_MS=20000 PERF_LOAD_MS=15000 npm run perf:report " + tag,
  ];
}

/**
 * Persist the run so a partial suite is never lost. Called after
 * every benchmark: an interrupted run (or a run killed by the clock
 * on a 30-minute budget) still leaves the measurements it *did*
 * take on disk.
 */
function writeJson(result: SuiteResult): string {
  const target = path.join(process.cwd(), "data", `perf-report-${result.device.tag}.json`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(result, null, 2));
  return target;
}

/**
 * Which benchmarks a tag runs by default.
 *
 * The desktop suite is the full four; the phone suite is the
 * Mobile render scene plus the on-device keyboard loop. The
 * transition / tick / load benchmarks are server-side and
 * device-independent, so a phone run does not re-measure them —
 * their rows belong to the desktop table.
 */
function defaultSuites(tag: string): readonly BenchmarkId[] {
  return tag === "phone"
    ? (["render", "phone-loop"] as const)
    : (["render", "transitions", "tick", "load"] as const);
}

/** Console line before each benchmark, so an interrupted run is readable. */
function announce(benchmark: BenchmarkId): void {
  // eslint-disable-next-line no-console
  console.log(`\n=== ${BENCHMARK_LABELS[benchmark]} ===`);
}

async function main(): Promise<void> {
  const { tag, bench, label } = parseArgs(process.argv.slice(2));
  const profile = profileForTag(tag);
  const rows: PerfRow[] = [];
  const wanted = bench ?? defaultSuites(tag);
  const wants = (id: BenchmarkId): boolean => wanted.includes(id);
  // eslint-disable-next-line no-console
  console.log(`[perf:report] tag=${tag} suites=${wanted.join(",")}`);

  /** Snapshot of what has been measured so far. */
  const partial = (): SuiteResult => ({
    device: describeDevice(tag, label),
    date: new Date().toISOString().slice(0, 10),
    gitSha: gitSha(),
    rows,
  });

  // eslint-disable-next-line no-console
  console.log(
    `[perf:report] tag=${tag} profile=${profile.id} render=${RENDER_MS}ms tick=${TICK_MS}ms load=${LOAD_MS}ms`,
  );

  if (wants("render")) {
    announce("render");
    runProfile(profile, 2_000, 1, true, "warmup");
    const runs = runProfile(profile, RENDER_MS, RENDER_RUNS, true, `tuned-${tag}`);
    rows.push(...renderRows(runs, profile));
    // eslint-disable-next-line no-console
    console.log(
      `median=${meanOf(runs.map((r) => r.medianMs)).toFixed(2)}ms ` +
        `p95=${meanOf(runs.map((r) => r.p95Ms)).toFixed(2)}ms (budget ${p95BudgetMs(profile)}ms) ` +
        `spikes=${runs.reduce((a, r) => a + r.spikes, 0)}`,
    );
    writeJson(partial());
  }
  if (wants("transitions")) {
    announce("transitions");
    rows.push(...collectTransitionRows(TRANSITION_RUNS));
    writeJson(partial());
  }
  if (wants("tick")) {
    announce("tick");
    rows.push(...(await collectTickRows(TICK_MS, 5_000)));
    writeJson(partial());
  }
  if (wants("load")) {
    announce("load");
    rows.push(...(await collectLoadRows(LOAD_MS)));
    writeJson(partial());
  }
  // The phone loop needs real hardware: no device, no number.
  let blocked = false;
  if (wants("phone-loop")) {
    announce("phone-loop");
    if (!phoneAttached()) {
      blocked = true;
      rows.push({
        benchmark: "phone-loop",
        metric: "keyboard-only loop, Mobile profile forced",
        budget: `no dropped frame > ${PHONE_LOOP_BUDGET_MS} ms`,
        measured: "no phone attached",
        verdict: "BLOCKED",
      });
    } else {
      rows.push(...phoneLoopRows());
    }
  }

  const result: SuiteResult = partial();
  const jsonPath = writeJson(result);

  // eslint-disable-next-line no-console
  console.log(`\n${formatDeviceHeader(result)}\n\n${formatTable(result)}`);
  const failures = failuresByOwner([result]);
  for (const failure of failures) {
    console.error(`[FAIL] ${failure.benchmark} / ${failure.metric} — re-open ${failure.owner}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n[perf:report] JSON written to ${jsonPath}`);
  // eslint-disable-next-line no-console
  console.log(`[perf:report] SC-3 (desktop) ${criterionVerdict([result], "SC-3")}`);
  // eslint-disable-next-line no-console
  console.log(`[perf:report] SC-4 (phone) ${criterionVerdict([result], "SC-4")}`);
  if (blocked) {
    // eslint-disable-next-line no-console
    console.log(
      formatBlockedNote(
        `no phone is attached to this host (neither ${PHONE_CDP_ENV} nor an ADB device)`,
        reproduceCommands(tag),
      ),
    );
  }
  process.exit(failures.length > 0 ? 1 : blocked ? 3 : 0);
}

/** Mean helper for the render console line. */
function meanOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

void main().catch((err: unknown) => {
  console.error("[perf:report] unexpected failure:", err);
  process.exit(2);
});
