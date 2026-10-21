/**
 * Perf report formatting + the SC-3 / SC-4 verdict rules — TASK-61.
 *
 * Pure: no clock, no fs, no process access. Everything
 * `docs/performance.md` renders comes from here so the markdown
 * shape and the verdict arithmetic are unit-tested
 * (`table.test.ts`) instead of eyeballed in a terminal.
 *
 * The three verdicts are deliberately distinct:
 *
 *   - `PASS` — every row owned by the criterion is green.
 *   - `FAIL` — at least one row owned by it is red. The owning
 *     benchmark's task is re-opened (never a new task).
 *   - `UNVERIFIED` — no red row, but the rows are `BLOCKED`
 *     (no device). This is what SC-4 is until a phone run
 *     happens; it is emphatically *not* a pass.
 */

/** Per-row outcome. `BLOCKED` means "no device, could not run". */
export type Verdict = "PASS" | "FAIL" | "BLOCKED";

/** Which benchmark a row belongs to (and, by extension, its owner task). */
export type BenchmarkId = "transitions" | "render" | "tick" | "load" | "phone-loop";

/** Owner task per benchmark — a FAIL re-opens the owner, never forks. */
export const BENCHMARK_OWNERS: Readonly<Record<BenchmarkId, string>> = Object.freeze({
  transitions: "TASK-30",
  render: "TASK-58",
  tick: "TASK-60",
  load: "TASK-18",
  "phone-loop": "TASK-54",
});

/** Human label for the benchmark column. */
export const BENCHMARK_LABELS: Readonly<Record<BenchmarkId, string>> = Object.freeze({
  transitions: "Transition hitch (TASK-30)",
  render: "Render 60 fps / 30 fps floor (TASK-58)",
  tick: "Server tick p95 (TASK-60)",
  load: "16-player load smoke (TASK-18)",
  "phone-loop": "Keyboard-only loop, Mobile forced (TASK-54)",
});

/** One measured metric against its budget. */
export interface PerfRow {
  readonly benchmark: BenchmarkId;
  readonly metric: string;
  /** The budget as written, e.g. `"p95 <= 20.00 ms"`. */
  readonly budget: string;
  /** What this machine measured, e.g. `"18.40 ms"`. */
  readonly measured: string;
  readonly verdict: Verdict;
}

/** The device a run was recorded on. */
export interface DeviceInfo {
  /** Short tag used as the CLI argument and the report slug. */
  readonly tag: string;
  readonly kind: "desktop" | "phone";
  /** Named device, e.g. `"Pixel 7a"`. Never silently substituted. */
  readonly label: string;
  readonly cpu: string;
  readonly memoryGb: number;
  readonly os: string;
  readonly gpu: string;
  /** How this device relates to the reference class. */
  readonly note: string;
}

/** One device's full suite run. */
export interface SuiteResult {
  readonly device: DeviceInfo;
  /** ISO date the run happened. */
  readonly date: string;
  /** Short git sha the run was recorded on. */
  readonly gitSha: string;
  readonly rows: readonly PerfRow[];
}

/** The two success criteria TASK-61 signs off. */
export type Criterion = "SC-3" | "SC-4";

/** How a criterion is decided from the rows. */
export type CriterionVerdict = "PASS" | "FAIL" | "UNVERIFIED";

/** Criteria plus the device kind whose rows each one owns. */
export const CRITERION_DEVICE_KIND: Readonly<Record<Criterion, "desktop" | "phone">> =
  Object.freeze({
    "SC-3": "desktop",
    "SC-4": "phone",
  });

/**
 * Decide one criterion from every suite result of the right kind.
 * A red row wins over a blocked row (a measured failure is worse
 * than an unmeasured one); with only blocked rows the criterion is
 * UNVERIFIED.
 */
export function criterionVerdict(
  results: readonly SuiteResult[],
  criterion: Criterion,
): CriterionVerdict {
  const kind = CRITERION_DEVICE_KIND[criterion];
  const rows = results
    .filter((result) => result.device.kind === kind)
    .flatMap((result) => result.rows);
  if (rows.length === 0) return "UNVERIFIED";
  if (rows.some((row) => row.verdict === "FAIL")) return "FAIL";
  if (rows.some((row) => row.verdict === "BLOCKED")) return "UNVERIFIED";
  return "PASS";
}

/** Every benchmark with at least one red row, with its owner task. */
export function failuresByOwner(
  results: readonly SuiteResult[],
): readonly { owner: string; benchmark: BenchmarkId; device: string; metric: string }[] {
  return results.flatMap((result) =>
    result.rows
      .filter((row) => row.verdict === "FAIL")
      .map((row) => ({
        owner: BENCHMARK_OWNERS[row.benchmark],
        benchmark: row.benchmark,
        device: result.device.label,
        metric: row.metric,
      })),
  );
}

/** Markdown table for one device: metric | budget | measured | verdict. */
export function formatTable(result: SuiteResult): string {
  const header =
    "| benchmark | metric | budget | measured | verdict |\n" + "| --- | --- | --- | --- | --- |";
  const lines = result.rows.map(
    (row) =>
      `| ${BENCHMARK_LABELS[row.benchmark]} | ${row.metric} | ${row.budget} | ${row.measured} | ${row.verdict} |`,
  );
  return [header, ...lines].join("\n");
}

/** The device header block printed above the table. */
export function formatDeviceHeader(result: SuiteResult): string {
  const d = result.device;
  return [
    `**Device:** ${d.label} (\`${d.tag}\`, ${d.kind})`,
    `- CPU: ${d.cpu}`,
    `- RAM: ${d.memoryGb} GB`,
    `- OS: ${d.os}`,
    `- GPU: ${d.gpu}`,
    `- Note: ${d.note}`,
    `- Date: ${result.date} @ \`${result.gitSha}\``,
  ].join("\n");
}

/** The BLOCKED-PENDING-DEVICE note plus the exact commands to run later. */
export function formatBlockedNote(reason: string, commands: readonly string[]): string {
  return [
    "### BLOCKED-PENDING-DEVICE",
    "",
    `Reason: ${reason}`,
    "",
    "Exact commands to run once a device is attached:",
    "",
    "```bash",
    ...commands,
    "```",
  ].join("\n");
}
