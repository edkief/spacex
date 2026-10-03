/**
 * TASK-30 CI test: the fast 1-cycle version of the transition-hitch bench.
 *
 * Runs the full scripted cycle once (headless, real pipeline) and asserts
 * the acceptance criteria that the full bench script (5-run variance)
 * checks statistically: every transition phase adds < 4 ms over its
 * baseline, no frame > 100 ms, zero budget warnings, the pre-generation
 * ring is ready before pad arrival, and the report has the AC4 shape.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { FrameMonitor } from '@client/perf/frameMonitor';
import { setPerfLogSink } from '@client/perf/logger';
import {
  analyzeCycle,
  CYCLE_PHASES,
  NO_PULL_MAX_MS,
  percentile,
  runTransitionCycle,
  TRANSITION_BUDGET_MS,
  TRANSITION_PHASES,
  TRANSITION_TAGS,
  type FrameSample,
  type PhaseName,
} from './transitionCycle';

describe('transition cycle (TASK-30, 1 fast cycle)', () => {
  beforeAll(() => {
    // Swallow the expected 'streaming backlog' perf warnings.
    setPerfLogSink(() => {});
  });

  afterAll(() => {
    setPerfLogSink(null);
  });

  // { retry: 2 }: frame deltas are WALL-CLOCK — under the parallel-suite
  // load one GC pause / worker preemption in a few hundred frames can push
  // the p99 past 4 ms without any transition-cost regression. A SUSTAINED
  // regression fails every attempt. The body is self-contained (a fresh
  // simulated cycle per attempt), so a retry is stateless.
  it(
    'keeps every transition under the 4 ms budget (60 s budget)',
    { timeout: 60_000, retry: 2 },
    () => {
      const phasesSeen: PhaseName[] = [];
      const report = runTransitionCycle({
        onFrame: (phase) => {
          phasesSeen.push(phase);
        },
      });

      // AC1: the 7 AC transition phases are all present, in cycle order.
      const reported = report.phases.map((p) => p.transition);
      for (const phase of TRANSITION_PHASES) expect(reported).toContain(phase);
      const order = CYCLE_PHASES.filter((p) => reported.includes(p as PhaseName));
      expect(reported).toEqual(order);

      // AC1: onFrame fired for every simulated frame, phases in CYCLE order.
      expect(phasesSeen.length).toBe(report.totalFrames);
      expect(phasesSeen.length).toBeGreaterThan(0);
      let maxIdx = -1;
      for (const phase of phasesSeen) {
        const idx = CYCLE_PHASES.indexOf(phase);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeGreaterThanOrEqual(maxIdx);
        maxIdx = idx;
      }

      // AC2: per-phase budget (p99 of the deltas) under 4 ms, zero warnings.
      for (const phase of report.phases) {
        expect(phase.worstDeltaP99Ms, `${phase.transition} p99 delta`).toBeLessThan(
          TRANSITION_BUDGET_MS,
        );
        expect(phase.budgetWarnings, `${phase.transition} warnings`).toBe(0);
        expect(phase.frames).toBeGreaterThan(0);
        // AC4 shape: the worst frame names the exact culprit.
        expect(phase.worstFrame).not.toBeNull();
        expect(phase.worstFrame!.transition).toBe(phase.transition);
        expect(phase.worstFrame!.frameIndex).toBeGreaterThanOrEqual(0);
        expect(typeof phase.worstFrame!.baselineMs).toBe('number');
        expect(typeof phase.worstFrame!.measuredMs).toBe('number');
        expect(typeof phase.worstFrame!.deltaMs).toBe('number');
        expect(phase.worstFrame!.deltaMs).toBeCloseTo(
          phase.worstFrame!.measuredMs - phase.worstFrame!.baselineMs,
          2,
        );
      }
      expect(report.budgetWarnings).toBe(0);

      // AC3: no-pull check — no frame anywhere in the cycle > 100 ms.
      expect(report.maxFrameMs).toBeLessThan(NO_PULL_MAX_MS);

      // AC2: the 3 s idle baselines exist and are positive for all scenes.
      expect(report.idleBaselines.map((b) => b.scene)).toEqual(['space', 'atmosphere', 'surface']);
      for (const baseline of report.idleBaselines) {
        expect(baseline.p50Ms).toBeGreaterThan(0);
        expect(baseline.p95Ms).toBeGreaterThanOrEqual(baseline.p50Ms);
        expect(baseline.frames).toBeGreaterThan(0);
      }

      // Step 3: the 7x7 pre-generation ring is ready BEFORE pad arrival.
      expect(report.padNearRingReadyAtArrival).toBe(true);
      expect(report.padNearRingFramesBeforeArrival).toBeGreaterThan(0);

      // Streaming phases are budgeted against the busy steady-streaming
      // control (recorded for the TASK-61 reference-hardware log).
      const control = report.streamingControl;
      expect(control.frames).toBeGreaterThan(0);
      expect(control.busyP50Ms).toBeGreaterThan(0);
      for (const phase of report.phases) {
        if (
          phase.transition === 'atmosphere-to-surface' ||
          phase.transition === 'surface-to-atmosphere'
        ) {
          expect(phase.baselineSource).toBe('streaming-control');
        }
      }

      // The camera handoff runs on the sim clock: its tags must be confined
      // to the 36-frame disembark / re-enter windows (the 600 ms handoffs).
      for (const phase of report.phases) {
        if (phase.transition === 'disembark' || phase.transition === 're-enter') {
          expect(phase.tagCounts['handoff'] ?? 0).toBeGreaterThan(0);
        } else {
          expect(phase.tagCounts['handoff'] ?? 0, `${phase.transition} handoff`).toBe(0);
        }
      }
    },
  );
});

describe('analyzeCycle + percentile (pure, synthetic samples)', () => {
  function makePhaseFrames(
    phase: PhaseName,
    startIdx: number,
    n: number,
    baseMs: number,
  ): FrameSample[] {
    const frames: FrameSample[] = [];
    for (let i = 0; i < n; i++) {
      frames.push({
        frameIndex: startIdx + i,
        phase,
        measuredMs: baseMs,
        stages: { atmosphereMs: 0, streamerMs: 0, sceneMs: 0, cameraMs: 0, oneShotMs: 0 },
        tags: [],
        regime: 'space',
      });
    }
    return frames;
  }

  function fullSampleSet(): FrameSample[] {
    const samples: FrameSample[] = [];
    let idx = 0;
    for (const phase of CYCLE_PHASES) {
      const n = phase === 'walk-10m' ? 60 : 40;
      samples.push(...makePhaseFrames(phase, idx, n, 1));
      idx += n;
    }
    return samples;
  }

  it('percentile is nearest-rank over an empty-safe input', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 99)).toBe(7);
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 99)).toBe(99);
    expect(percentile(v, 100)).toBe(100);
  });

  it('computes deltas against the right baseline and flags the culprit', () => {
    const samples = fullSampleSet();
    // Tag two walk-10m frames with a 2 ms spike (under budget, 1 above 4).
    const walk = samples.filter((s) => s.phase === 'walk-10m');
    walk[10].tags.push('handoff');
    walk[10].measuredMs += 2;
    walk[11].tags.push('handoff');
    walk[11].measuredMs += 4.5;

    const monitor = new FrameMonitor();
    const report = analyzeCycle(samples, monitor, (fi) => fi * (1000 / 60));

    expect(report.budgetWarnings).toBeGreaterThan(0);
    const walkReport = report.phases.find((p) => p.transition === 'walk-10m')!;
    // walk-10m has tagged frames: the budgeted set is the tagged ones.
    expect(walkReport.taggedFrames).toBe(2);
    expect(walkReport.baselineSource).toBe('phase-steady');
    expect(walkReport.baselineMs).toBeCloseTo(1, 3);
    expect(walkReport.worstFrame!.deltaMs).toBeCloseTo(4.5, 3);
    expect(walkReport.worstFrame!.frameIndex).toBe(walk[11].frameIndex);
    expect(walkReport.worstDeltaMs).toBeCloseTo(4.5, 3);
    expect(report.worstDeltaMs).toBeCloseTo(4.5, 3);
  });

  it('uses the busy streaming control as baseline for streaming phases', () => {
    const samples = fullSampleSet();
    // Control: 40 frames, 20 of them "busy" (streamer stage > 0.5 ms) at 4 ms.
    const control = samples.filter((s) => s.phase === 'steady-streaming-control');
    for (let i = 0; i < control.length; i++) {
      if (i % 2 === 0) {
        control[i].stages.streamerMs = 4;
        control[i].measuredMs = 4;
      }
    }
    // Give atmosphere-to-surface a tagged spike frame.
    const des = samples.filter((s) => s.phase === 'atmosphere-to-surface');
    des[5].tags.push('chunk-boundary');
    des[5].measuredMs = 5;

    const report = analyzeCycle(samples, new FrameMonitor(), (fi) => fi * (1000 / 60));
    const desReport = report.phases.find((p) => p.transition === 'atmosphere-to-surface')!;
    expect(desReport.baselineSource).toBe('streaming-control');
    expect(desReport.baselineMs).toBeCloseTo(4, 3);
    expect(desReport.worstFrame!.deltaMs).toBeCloseTo(1, 3);

    // Handoff phases fall back to the idle-surface baseline.
    const dis = report.phases.find((p) => p.transition === 'disembark')!;
    expect(dis.baselineSource).toBe('idle');
    expect(dis.baselineMs).toBeCloseTo(1, 3);
  });

  it('treats untagged-tagged frames as steady and skips unknown tags', () => {
    const samples = fullSampleSet();
    const walk = samples.filter((s) => s.phase === 'walk-10m');
    walk[0].tags.push('not-a-transition-tag'); // must NOT be budgeted
    const report = analyzeCycle(samples, new FrameMonitor(), (fi) => fi * (1000 / 60));
    const walkReport = report.phases.find((p) => p.transition === 'walk-10m')!;
    // No transition tags → the whole phase is the budgeted set.
    expect(walkReport.taggedFrames).toBe(0);
    expect(TRANSITION_TAGS.has('not-a-transition-tag')).toBe(false);
  });
});
