/**
 * HUD work timing — TASK-50 / TASK-57.
 *
 * The combat HUD is 10 Hz state-driven (snapshot cadence), with the
 * single per-frame cost being the target-box projection: one style
 * write onto a ref'd node. This helper wraps that work so the
 * frame monitor can assert the budget (`HUD_FRAME_BUDGET_MS = 1`)
 * instead of the assertion living in a comment.
 *
 * `timeHudWork` records the elapsed wall-clock into the frame
 * monitor's `hud` category and runs `budgetCheck("hud", …)`.
 */

import type { FrameMonitor } from "../../perf/frameMonitor.js";
import { HUD_FRAME_BUDGET_MS, HUD_FRAME_CATEGORY } from "./layout.js";

/** Options for the timing wrapper. */
export interface HudTimingOptions {
  /** Frame monitor to record into (omit to skip recording). */
  monitor?: FrameMonitor | null;
  /** Wall clock, injectable for deterministic tests. */
  now?: () => number;
  /** Budget in ms (default `HUD_FRAME_BUDGET_MS`). */
  budgetMs?: number;
}

/**
 * Time `work()` and record the duration. Returns the measured
 * milliseconds so the caller (and the tests) can assert the budget
 * without reaching into the monitor.
 *
 * A throwing `work` still records the elapsed time before
 * rethrowing — a budget miss that crashes the render loop should
 * not hide itself from the monitor.
 */
export function timeHudWork(work: () => void, opts: HudTimingOptions = {}): number {
  const now = opts.now ?? defaultNow;
  const start = now();
  let thrown: unknown = null;
  try {
    work();
  } catch (err) {
    thrown = err;
  }
  const elapsed = Math.max(0, now() - start);
  opts.monitor?.recordCategoryCount(HUD_FRAME_CATEGORY, elapsed);
  opts.monitor?.budgetCheck(HUD_FRAME_CATEGORY, elapsed, opts.budgetMs ?? HUD_FRAME_BUDGET_MS);
  if (thrown !== null) throw thrown;
  return elapsed;
}

/** Monotonic-ish clock; falls back to `Date.now` outside browsers. */
function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}
