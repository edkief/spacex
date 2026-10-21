/**
 * Perf report table + verdict rules — TASK-61.
 *
 * The SC-3 / SC-4 verdicts are the sign-off artefact of the whole
 * project, so the arithmetic that produces them is asserted here
 * rather than read off a terminal: a red row must beat a blocked
 * row, a blocked device must never read as a pass, and a green
 * desktop suite must pass SC-3.
 */
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_OWNERS,
  criterionVerdict,
  failuresByOwner,
  formatBlockedNote,
  formatDeviceHeader,
  formatTable,
  type DeviceInfo,
  type PerfRow,
  type SuiteResult,
} from "./table.js";

const DESKTOP: DeviceInfo = {
  tag: "desktop",
  kind: "desktop",
  label: "test desktop",
  cpu: "test cpu",
  memoryGb: 16,
  os: "test os",
  gpu: "none",
  note: "n/a",
};

const PHONE: DeviceInfo = { ...DESKTOP, tag: "phone", kind: "phone", label: "test phone" };

/** One green row. */
function green(benchmark: PerfRow["benchmark"], metric = "m"): PerfRow {
  return { benchmark, metric, budget: "< 1.00 ms", measured: "0.10 ms", verdict: "PASS" };
}

/** One red row. */
function red(benchmark: PerfRow["benchmark"], metric = "m"): PerfRow {
  return { benchmark, metric, budget: "< 1.00 ms", measured: "2.00 ms", verdict: "FAIL" };
}

/** One unmeasurable row (no device). */
function blocked(benchmark: PerfRow["benchmark"], metric = "m"): PerfRow {
  return { benchmark, metric, budget: "< 1.00 ms", measured: "n/a", verdict: "BLOCKED" };
}

/** Wrap rows into a suite result. */
function suite(device: DeviceInfo, rows: readonly PerfRow[]): SuiteResult {
  return { device, date: "2026-10-21", gitSha: "abc1234", rows };
}

describe("criterionVerdict", () => {
  it("passes SC-3 when every desktop row is green", () => {
    const results = [suite(DESKTOP, [green("render"), green("tick"), green("load")])];
    expect(criterionVerdict(results, "SC-3")).toBe("PASS");
  });

  it("fails SC-3 when one desktop benchmark is red", () => {
    const results = [suite(DESKTOP, [green("render"), red("tick")])];
    expect(criterionVerdict(results, "SC-3")).toBe("FAIL");
  });

  it("reports SC-4 as UNVERIFIED — never PASS — when no phone ran", () => {
    const results = [suite(PHONE, [blocked("render"), blocked("phone-loop")])];
    expect(criterionVerdict(results, "SC-4")).toBe("UNVERIFIED");
  });

  it("does not let a desktop green hide a missing phone", () => {
    const results = [
      suite(DESKTOP, [green("render")]),
      suite(PHONE, [blocked("render"), blocked("phone-loop")]),
    ];
    expect(criterionVerdict(results, "SC-3")).toBe("PASS");
    expect(criterionVerdict(results, "SC-4")).toBe("UNVERIFIED");
  });

  it("prefers a measured failure over a blocked row", () => {
    const results = [suite(PHONE, [red("render"), blocked("phone-loop")])];
    expect(criterionVerdict(results, "SC-4")).toBe("FAIL");
  });

  it("is UNVERIFIED when the device kind has no rows at all", () => {
    expect(criterionVerdict([], "SC-3")).toBe("UNVERIFIED");
  });
});

describe("failuresByOwner", () => {
  it("names the owning task of every red row", () => {
    const failures = failuresByOwner([suite(DESKTOP, [red("tick", "p95"), green("load")])]);
    expect(failures).toEqual([
      { owner: "TASK-60", benchmark: "tick", device: "test desktop", metric: "p95" },
    ]);
  });

  it("does not list blocked rows as failures", () => {
    expect(failuresByOwner([suite(PHONE, [blocked("render")])])).toEqual([]);
  });

  it("maps each benchmark to its owning task", () => {
    expect(Object.values(BENCHMARK_OWNERS).sort()).toEqual([
      "TASK-18",
      "TASK-30",
      "TASK-54",
      "TASK-58",
      "TASK-60",
    ]);
  });
});

describe("formatting", () => {
  it("renders one markdown row per measurement with the device stamped", () => {
    const table = formatTable(suite(DESKTOP, [green("render", "median frame time")]));
    expect(table).toContain("| benchmark | metric | budget | measured | verdict |");
    expect(table).toContain("Render 60 fps / 30 fps floor (TASK-58) | median frame time");
    expect(table).toContain("| PASS |");
  });

  it("stamps the device, date and sha in the header", () => {
    const header = formatDeviceHeader(suite(DESKTOP, []));
    expect(header).toContain("test desktop");
    expect(header).toContain("2026-10-21");
    expect(header).toContain("abc1234");
  });

  it("keeps the blocked note honest: a reason plus runnable commands", () => {
    const note = formatBlockedNote("no phone attached", [
      "adb devices -l",
      "npm run perf:report phone",
    ]);
    expect(note).toContain("BLOCKED-PENDING-DEVICE");
    expect(note).toContain("no phone attached");
    expect(note).toContain("npm run perf:report phone");
  });
});
