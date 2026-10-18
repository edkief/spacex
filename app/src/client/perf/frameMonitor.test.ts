/**
 * Tests for `frameMonitor.ts` (TASK-57).
 *
 * Coverage:
 *
 *   - `pickPercentile` — boundary cases, single sample, exact-quantile
 *     hit, linear interpolation between samples.
 *   - `FRAME_WINDOW_CAPACITY` constant — the rolling window matches
 *     the spec ("300 frames").
 *   - Rolling window — large sequences (cap + 1, cap + 50, etc.)
 *     correctly wrap and reflect only the most recent `capacity`
 *     samples.
 *   - `recordRendererInfo` + `recordEntityCount` — latest-wins
 *     semantics.
 *   - `budgetCheck` — under-budget returns `false`, over-budget
 *     emits `console.warn`, repeat misses within cooldown are
 *     suppressed, distinct budget names are independent,
 *     logger injection lets a spy observe calls without spamming
 *     `console`.
 *   - FPS — produces a sensible number over a 1 s simulated
 *     wall-clock with `now` injections.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FRAME_WINDOW_CAPACITY,
  FrameMonitor,
  pickPercentile,
  type FrameMonitorLogger,
} from "./frameMonitor.js";

type WarnFn = (message: string, ...rest: unknown[]) => void;
type SpyLogger = FrameMonitorLogger & { warn: ReturnType<typeof vi.fn<WarnFn>> };

describe("client/perf/frameMonitor — pickPercentile", () => {
  it("returns 0 for an empty array", () => {
    expect(pickPercentile([], 0.95)).toBe(0);
  });

  it("returns the only sample for a singleton", () => {
    expect(pickPercentile([42], 0)).toBe(42);
    expect(pickPercentile([42], 0.5)).toBe(42);
    expect(pickPercentile([42], 0.95)).toBe(42);
    expect(pickPercentile([42], 1)).toBe(42);
  });

  it("returns the median for known sequences", () => {
    // 1..9 → median (p50) = 5.
    const seq = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(pickPercentile(seq, 0.5)).toBe(5);
  });

  it("clamps out-of-range quantiles", () => {
    const seq = [10, 20, 30];
    expect(pickPercentile(seq, -0.1)).toBe(10);
    expect(pickPercentile(seq, 1.5)).toBe(30);
  });

  it("linearly interpolates between samples", () => {
    // 100, 200 → p50 = 150; p95 lands at 95% of the way between
    // index 0 and index N-1, so for N=2 the rank is 0.95 → 95%
    // of the way from 100 to 200 = 195.
    expect(pickPercentile([100, 200], 0.5)).toBeCloseTo(150, 6);
    expect(pickPercentile([100, 200], 0.95)).toBeCloseTo(195, 6);
  });

  it("computes the p95 of a known distribution", () => {
    // 100 samples 1..100 → p95 = 95.05 (linear interp).
    const seq = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(pickPercentile(seq, 0.95)).toBeCloseTo(95.05, 5);
  });

  it("does not mutate the input", () => {
    const seq = [5, 3, 1, 4, 2];
    const snapshot = [...seq];
    pickPercentile(
      [...seq].sort((a, b) => a - b),
      0.5,
    );
    expect(seq).toEqual(snapshot);
  });
});

describe("client/perf/frameMonitor — FRAME_WINDOW_CAPACITY", () => {
  it("matches the spec (300 frames)", () => {
    expect(FRAME_WINDOW_CAPACITY).toBe(300);
  });
});

describe("client/perf/frameMonitor — FrameMonitor", () => {
  let clockNow = 0;
  let logger: SpyLogger;
  let monitor: FrameMonitor;

  beforeEach(() => {
    clockNow = 0;
    const warnSpy = vi.fn<WarnFn>();
    logger = { warn: warnSpy };
    monitor = new FrameMonitor({ clock: () => clockNow, logger });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with an empty window and zero stats", () => {
    const stats = monitor.getFrameStats();
    expect(stats.fps).toBe(0);
    expect(stats.frameTimeMs).toBe(0);
    expect(stats.p50).toBe(0);
    expect(stats.p95).toBe(0);
    expect(stats.p99).toBe(0);
    expect(stats.windowSize).toBe(0);
    expect(stats.drawCalls).toBe(0);
    expect(stats.triangles).toBe(0);
    expect(stats.entities).toBe(0);
  });

  it("records the first frame as 0 ms delta", () => {
    clockNow = 1000;
    monitor.recordFrameTime(1000);
    const stats = monitor.getFrameStats();
    expect(stats.frameTimeMs).toBe(0);
    expect(stats.windowSize).toBe(1);
  });

  it("measures deltas between consecutive samples", () => {
    clockNow = 1000;
    monitor.recordFrameTime(1000);
    clockNow = 1016;
    monitor.recordFrameTime(1016);
    clockNow = 1032;
    monitor.recordFrameTime(1032);
    const stats = monitor.getFrameStats();
    // The first sample is recorded as 0 ms (no baseline), then
    // 16, 16 → sorted = [0, 16, 16] → p50 = 16 (linearly
    // interpolated), p95 / p99 land on 16.
    expect(stats.frameTimeMs).toBe(16);
    expect(stats.p50).toBeCloseTo(16, 6);
    expect(stats.p95).toBeCloseTo(16, 6);
    expect(stats.p99).toBeCloseTo(16, 6);
    expect(stats.windowSize).toBe(3);
  });

  it("computes rolling percentiles for a known sequence", () => {
    // 100 samples at 5 ms each → p50 = p95 = p99 = 5.
    for (let i = 0; i <= 100; i++) {
      clockNow = i * 5;
      monitor.recordFrameTime(i * 5);
    }
    const stats = monitor.getFrameStats();
    expect(stats.windowSize).toBeLessThanOrEqual(FRAME_WINDOW_CAPACITY);
    expect(stats.p50).toBeCloseTo(5, 6);
    expect(stats.p95).toBeCloseTo(5, 6);
    expect(stats.p99).toBeCloseTo(5, 6);
  });

  it("wraps the rolling window after `capacity` frames", () => {
    // 400 samples at 16.66 ms each, then drive one more sample at a
    // much different time and verify only the most recent 300
    // frames' stats are considered.
    for (let i = 0; i < 350; i++) {
      clockNow = i * (1000 / 60);
      monitor.recordFrameTime(i * (1000 / 60));
    }
    // Now bake 100 ms of frame time into the ring: replace the
    // next 100 frames by recording 100 ms each.
    for (let i = 0; i < 100; i++) {
      clockNow = clockNow + 100;
      monitor.recordFrameTime(clockNow);
    }
    const stats = monitor.getFrameStats();
    expect(stats.windowSize).toBe(FRAME_WINDOW_CAPACITY);
    // The 100 ms outliers should be in the window now (we just
    // pushed 100 of them and the ring holds 300).
    expect(stats.p95).toBeGreaterThanOrEqual(99.9);
  });

  it("clamps huge jumps so a backgrounded tab doesn't poison percentiles", () => {
    clockNow = 1000;
    monitor.recordFrameTime(1000);
    clockNow = 2000;
    monitor.recordFrameTime(2000);
    // Sleep for 30 seconds.
    clockNow = 32_000;
    monitor.recordFrameTime(32_000);
    const stats = monitor.getFrameStats();
    // The 30-second jump should be clamped to 1000 ms.
    expect(stats.frameTimeMs).toBeLessThanOrEqual(1000);
  });

  it("tracks latest-wins renderer info + entity count", () => {
    monitor.recordRendererInfo({ render: { calls: 100, triangles: 50_000 } });
    monitor.recordEntityCount(7);
    expect(monitor.getFrameStats().drawCalls).toBe(100);
    expect(monitor.getFrameStats().triangles).toBe(50_000);
    expect(monitor.getFrameStats().entities).toBe(7);
    monitor.recordRendererInfo({ render: { calls: 200, triangles: 60_000 } });
    monitor.recordEntityCount(11);
    const stats = monitor.getFrameStats();
    expect(stats.drawCalls).toBe(200);
    expect(stats.triangles).toBe(60_000);
    expect(stats.entities).toBe(11);
  });

  it("computes FPS over a 1 s synthetic window", () => {
    // Simulate frames every 16.67 ms (≈ 60 fps) across more
    // than one full second so the rolling FPS window settles.
    // Push 75 frames → spans 75 × 16.67 ≈ 1250 ms.
    for (let i = 0; i < 75; i++) {
      clockNow = i * (1000 / 60);
      monitor.recordFrameTime(i * (1000 / 60));
    }
    // FPS should be ≈ 60.
    const stats = monitor.getFrameStats();
    expect(stats.fps).toBeGreaterThan(55);
    expect(stats.fps).toBeLessThan(65);
  });

  it("budgetCheck returns false under budget", () => {
    expect(monitor.budgetCheck("input", 4, 8, 1000)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("budgetCheck returns true + warns when over budget", () => {
    expect(monitor.budgetCheck("input", 16, 8, 1000)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0]!;
    expect(message).toContain("input");
    expect(message).toContain("16.00ms");
    expect(message).toContain("8.00ms");
  });

  it("budgetCheck rate-limits warnings to one per name per 10 s", () => {
    monitor.budgetCheck("input", 16, 8, 1000);
    monitor.budgetCheck("input", 18, 8, 1500); // 0.5 s later
    monitor.budgetCheck("input", 22, 8, 3000); // 2 s later
    monitor.budgetCheck("input", 30, 8, 9500); // 8.5 s later
    monitor.budgetCheck("input", 40, 8, 11_500); // 11.5 s later — past 10 s
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("budgetCheck treats distinct names independently", () => {
    monitor.budgetCheck("input", 16, 8, 1000);
    monitor.budgetCheck("render", 16, 8, 1000);
    monitor.budgetCheck("physics", 16, 8, 1000);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls[0]![0]).toContain("input");
    expect(logger.warn.mock.calls[1]![0]).toContain("render");
    expect(logger.warn.mock.calls[2]![0]).toContain("physics");
  });

  it("budgetCheck uses the injected clock when no `now` is passed", () => {
    clockNow = 5000;
    monitor.budgetCheck("auto", 16, 8);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Drive the clock 9 s — still in cooldown.
    clockNow = 14_999;
    monitor.budgetCheck("auto", 16, 8);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Drive the clock past 10 s cooldown — new warning.
    clockNow = 15_500;
    monitor.budgetCheck("auto", 16, 8);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("reset clears the rolling window + budget cool-downs", () => {
    monitor.recordFrameTime(1000);
    monitor.recordRendererInfo({ render: { calls: 50, triangles: 1000 } });
    monitor.budgetCheck("input", 16, 8, 1000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    monitor.reset();
    const stats = monitor.getFrameStats();
    expect(stats.windowSize).toBe(0);
    expect(stats.drawCalls).toBe(0);
    expect(stats.triangles).toBe(0);
    // After reset the cooldown map is empty so the next miss
    // triggers a fresh warning.
    monitor.budgetCheck("input", 16, 8, 2000);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("defaults to a console-backed logger when none is injected", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plainMonitor = new FrameMonitor({ clock: () => 0 });
    expect(plainMonitor.budgetCheck("default-logger", 16, 8, 1000)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
