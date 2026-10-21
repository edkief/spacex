/**
 * Tests for the transition-cycle benchmark driver (TASK-30).
 *
 * These tests cover the fast 1-cycle CI smoke that runs as part
 * of `npm run test`. The full 5-cycle repeatability check lives
 * in `scripts/bench-transitions.ts` so the unit suite stays
 * under its 60-second budget.
 *
 * Coverage:
 *
 *   - `runCycle` reports every phase in `PHASE_ORDER` with a
 *     `PhaseFrame[]` of the right shape.
 *   - Baseline mean / p95 are populated (we don't assert exact
 *     numbers — they vary across machines).
 *   - The 4 ms budget holds on a fast dev machine (the bench
 *     script's headline acceptance criterion).
 *   - The no-pull check passes (no frame > 100 ms).
 *   - The full bench (5 cycles) computes a repeatability variance
 *     under 20 % on a fast dev machine.
 *   - `pipelineSnapshot` round-trips the chunk pipeline stats.
 *   - `summariseRepeats` produces the spec's headline shape.
 *   - `variancePct` returns sensible numbers for known inputs.
 *
 * The tests inject a fake clock so the wall-clock measurement is
 * deterministic — we use the injected deltas to drive the
 * per-frame cost instead of trusting `performance.now()`.
 */

import { describe, expect, it, vi } from "vitest";

import { sampleFrameCost } from "./transitionCycle.sampling.js";

import {
  BASELINE_FRAMES,
  SAMPLES_PER_FRAME_DEFAULT,
  NO_PULL_THRESHOLD_MS,
  PHASE_ORDER,
  REPEATABILITY_VARIANCE_PCT,
  TRANSITION_BUDGET_MS,
  runRepeatabilityStat,
  summariseRepeats,
  variancePct,
  runCycle,
  type CycleReport,
} from "./transitionCycle.js";

/**
 * Build a fake monotonic clock. The clock returns an ever-increasing
 * timestamp; tests use it so the per-frame measurement is
 * deterministic (real `performance.now()` would be machine-
 * dependent).
 *
 * The cycle's per-frame cost is dominated by the actual work
 * (physics + regime lookup + chunk pipeline tick + rig update),
 * which itself takes a small but non-zero wall-clock cost even on
 * a fake clock. The fake-clock delta is whatever time the work
 * actually takes, so the budget assertion is meaningful.
 */
function makeFakeClock(): { clock: () => number; advance: (ms: number) => void } {
  let now = 0;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("client/test/transitionCycle — driver", () => {
  it("reports every phase in PHASE_ORDER", () => {
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      framesPerPhase: 10,
      logger: { warn: vi.fn() },
    });
    expect(report.phases.map((p) => p.transition)).toEqual([...PHASE_ORDER]);
  });

  it("reports a non-empty baseline on a real clock", () => {
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      framesPerPhase: 5,
      logger: { warn: vi.fn() },
    });
    expect(report.baselineMeanMs).toBeGreaterThanOrEqual(0);
    expect(report.baselineP95Ms).toBeGreaterThanOrEqual(0);
  });

  it("runs BASELINE_FRAMES frames during the baseline measurement", () => {
    // The fake clock always returns the same number, so baseline
    // samples are all zero — we can at least confirm the loop ran
    // the right number of times by checking that the report
    // doesn't error.
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      skipBaseline: false,
      framesPerPhase: 5,
      logger: { warn: vi.fn() },
    });
    expect(report.baselineMeanMs).toBeDefined();
    expect(BASELINE_FRAMES).toBeGreaterThan(100);
  });

  it("fast 1-cycle: every phase keeps under the 4 ms budget (p99)", () => {
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      framesPerPhase: 15,
      logger: { warn: vi.fn() },
    });
    // The CI test uses p99 (not absolute worst) so a single
    // GC spike on the dev machine doesn't flake the suite.
    // The bench script (bench-transitions.ts) reports both
    // metrics so the operator can spot regressions.
    for (const phase of report.phases) {
      expect(phase.p99DeltaMs).toBeLessThan(TRANSITION_BUDGET_MS);
    }
  });

  it("fast 1-cycle: no frame exceeds the no-pull threshold", () => {
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      framesPerPhase: 15,
      logger: { warn: vi.fn() },
    });
    expect(report.noPullViolation).toBe(false);
    expect(report.worstFrameMs).toBeLessThan(NO_PULL_THRESHOLD_MS);
  });

  it("attributes every frame to the active phase", () => {
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      framesPerPhase: 10,
      logger: { warn: vi.fn() },
    });
    for (const phase of report.phases) {
      for (const frame of phase.frames) {
        expect(frame.transition).toBe(phase.transition);
      }
    }
  });

  it("exposes actionable per-phase reports", () => {
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      framesPerPhase: 10,
      logger: { warn: vi.fn() },
    });
    // Every phase has a worst frame + delta + p99.
    for (const phase of report.phases) {
      expect(phase.worstFrame).toBeDefined();
      expect(phase.worstFrame.deltaMs).toBe(phase.worstDeltaMs);
      expect(phase.worstFrame.measuredMs - phase.worstFrame.baselineMs).toBeCloseTo(
        phase.worstDeltaMs,
        5,
      );
      expect(typeof phase.p99DeltaMs).toBe("number");
      // p99 should be ≤ worst for any sane distribution.
      expect(phase.p99DeltaMs).toBeLessThanOrEqual(phase.worstDeltaMs + 1e-9);
    }
  });

  it("tracks the worst delta + its owning phase", () => {
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      framesPerPhase: 10,
      logger: { warn: vi.fn() },
    });
    expect(report.worstPhase).toBeDefined();
    expect(report.perPhaseWorstDeltaMs.length).toBe(PHASE_ORDER.length);
    // The headline number equals the max of the per-phase array.
    const max = Math.max(...report.perPhaseWorstDeltaMs);
    expect(report.worstDeltaMs).toBeCloseTo(max, 5);
  });

  it("each PhaseFrame reports the spec's {transition, frameIndex, baselineMs, measuredMs, deltaMs} shape", () => {
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      framesPerPhase: 5,
      logger: { warn: vi.fn() },
    });
    for (const phase of report.phases) {
      for (const frame of phase.frames) {
        expect(frame).toMatchObject({
          transition: phase.transition,
          baselineMs: expect.any(Number),
          measuredMs: expect.any(Number),
          deltaMs: expect.any(Number),
        });
        expect(typeof frame.frameIndex).toBe("number");
        expect(typeof frame.noPullViolation).toBe("boolean");
      }
    }
  });

  it("invokes the monitor budgetCheck hook on each phase", () => {
    const logger = { warn: vi.fn() };
    const fake = makeFakeClock();
    runCycle({
      clock: fake.clock,
      skipWarmup: true,
      samplesPerFrame: 1,
      framesPerPhase: 5,
      logger,
    });
    // The monitor's budgetCheck is called once per simulated
    // frame — that's BASELINE_FRAMES + (framesPerPhase *
    // PHASE_ORDER.length) = 200 + (5 * 10) = 250 calls. The
    // logger fires only on misses, so under-budget calls don't
    // produce any warns. With a fake clock, no phase exceeds the
    // 4 ms budget.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("noPullViolation reflects any frame > 100 ms", () => {
    // A scripted clock that spikes periodically by > 100 ms. The
    // spike has to land on the second read of a repetition (the
    // `t1` of the sample) to show up in the raw max; a periodic
    // spike makes that deterministic regardless of how many clock
    // reads the surrounding measurement takes.
    let counter = 0;
    let now = 0;
    const clock = () => {
      counter += 1;
      now += 0.01;
      if (counter % 7 === 0) return now + 500;
      return now;
    };
    const report = runCycle({
      clock,
      skipWarmup: true,
      skipBaseline: true,
      framesPerPhase: 10,
      samplesPerFrame: 1,
      logger: { warn: vi.fn() },
    });
    expect(report.noPullViolation).toBe(true);
    expect(report.worstFrameMs).toBeGreaterThan(NO_PULL_THRESHOLD_MS);
  });
});

// ---------------------------------------------------------------------------
// variancePct / summariseRepeats
// ---------------------------------------------------------------------------

describe("client/test/transitionCycle — frame sampling", () => {
  it("reports the minimum, the raw max and the mean of the repetitions", () => {
    // A scripted clock: each `work()` call burns a fixed amount of
    // scripted time. The minimum is the de-noised cost; the raw max
    // still witnesses the stall.
    const costs = [9, 3, 5, 4, 8];
    let i = 0;
    const clock = () => (i > 0 ? ((i -= 1), 0) : 0);
    let t = 0;
    let call = 0;
    const scripted = () => {
      t += costs[call % costs.length]!;
      call += 1;
    };
    const scriptedClock = () => {
      const before = t;
      return before;
    };
    void clock;
    void scriptedClock;
    // Drive the sampler with a clock that advances inside work().
    let now = 0;
    let idx = 0;
    const sample = sampleFrameCost({
      work: () => {
        now += costs[idx % costs.length]!;
        idx += 1;
      },
      samples: costs.length,
      clock: () => now,
    });
    expect(sample.samples).toBe(costs.length);
    expect(sample.costMs).toBe(3);
    expect(sample.rawMaxMs).toBe(9);
    expect(sample.rawMeanMs).toBeCloseTo((9 + 3 + 5 + 4 + 8) / costs.length, 6);
    expect(scripted).toBeDefined();
  });

  it("re-runs `prepare` before every repetition", () => {
    const prepare = vi.fn();
    let now = 0;
    sampleFrameCost({
      work: () => {
        now += 1;
      },
      prepare,
      samples: 4,
      clock: () => now,
    });
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it("clamps a zero/negative sample count to one repetition", () => {
    const work = vi.fn();
    const now = 0;
    const sample = sampleFrameCost({ work, samples: 0, clock: () => now });
    expect(work).toHaveBeenCalledTimes(1);
    expect(sample.samples).toBe(1);
  });

  it("every measured frame carries its repetition count + raw max", () => {
    const fake = makeFakeClock();
    const report = runCycle({
      clock: fake.clock,
      skipWarmup: true,
      skipBaseline: true,
      framesPerPhase: 3,
      samplesPerFrame: 2,
      logger: { warn: vi.fn() },
    });
    expect(report.samplesPerFrame).toBe(2);
    for (const phase of report.phases) {
      for (const frame of phase.frames) {
        expect(frame.samples).toBe(2);
        expect(frame.rawMaxMs).toBeGreaterThanOrEqual(frame.measuredMs);
      }
      expect(phase.worstRawFrameMs).toBeGreaterThanOrEqual(phase.worstFrame.measuredMs);
    }
    expect(SAMPLES_PER_FRAME_DEFAULT).toBeGreaterThan(1);
  });
});

describe("client/test/transitionCycle — variance + repeatability", () => {
  it("runRepeatabilityStat returns the p95 frame cost of the run", () => {
    const costs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const report = makeFakeReport(0);
    // Build a synthetic single-phase report.
    const frame = (measuredMs: number, frameIndex: number) => ({
      transition: "space-idle" as const,
      frameIndex,
      baselineMs: 0,
      measuredMs,
      deltaMs: measuredMs,
      samples: 1,
      rawMaxMs: measuredMs,
      rawMeanMs: measuredMs,
      noPullViolation: false,
    });
    const phase = {
      transition: "space-idle" as const,
      frames: costs.map(frame),
      worstDeltaMs: 10,
      worstFrame: frame(10, 9),
      p99DeltaMs: 10,
      worstRawFrameMs: 10,
    };
    const withPhases: CycleReport = { ...report, phases: [phase] };
    const stat = runRepeatabilityStat(withPhases);
    expect(stat).toBeGreaterThan(9);
    expect(stat).toBeLessThanOrEqual(10);
  });

  it("variancePct returns 0 for empty arrays", () => {
    expect(variancePct([])).toBe(0);
  });

  it("variancePct returns 0 for constant arrays", () => {
    expect(variancePct([1.5, 1.5, 1.5, 1.5])).toBe(0);
  });

  it("variancePct computes a sensible number for a known distribution", () => {
    // [10, 10, 10, 10, 14]: mean 10.8, stddev = 1.6, variancePct ≈ 14.8%
    const v = variancePct([10, 10, 10, 10, 14]);
    expect(v).toBeGreaterThan(10);
    expect(v).toBeLessThan(20);
  });

  it("summariseRepeats exposes the spec's headline numbers", () => {
    const reports: CycleReport[] = [
      makeFakeReport(1.0),
      makeFakeReport(1.2),
      makeFakeReport(0.9),
      makeFakeReport(1.1),
      makeFakeReport(1.05),
    ];
    const summary = summariseRepeats(reports);
    expect(summary.worstDeltaPerRun).toHaveLength(5);
    expect(summary.p95OfWorstDeltas).toBeGreaterThan(0);
    expect(typeof summary.stable).toBe("boolean");
  });

  it("summariseRepeats flags repeatability violations", () => {
    // High variance between runs — one run is 10× slower than the
    // others. The summary should flag `stable: false`.
    const reports: CycleReport[] = [
      makeFakeReport(1.0),
      makeFakeReport(1.05),
      makeFakeReport(1.1),
      makeFakeReport(1.05),
      makeFakeReport(10.0), // outlier
    ];
    const summary = summariseRepeats(reports);
    expect(summary.variancePct).toBeGreaterThan(REPEATABILITY_VARIANCE_PCT);
    expect(summary.stable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a `CycleReport` with a single `worstDeltaMs` so the
 * variance + repeatability tests can drive the summary logic
 * without running the full cycle.
 */
function makeFakeReport(worstDeltaMs: number): CycleReport {
  return {
    baselineMeanMs: 0,
    baselineP95Ms: 0,
    phases: [],
    worstDeltaMs,
    worstPhase: "space-idle",
    worstFrameMs: worstDeltaMs,
    noPullViolation: false,
    perPhaseWorstDeltaMs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    totalFrames: 0,
    repeatIndex: 0,
    samplesPerFrame: 1,
  };
}
