import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUDGET_WARN_COOLDOWN_MS, FRAME_WINDOW_SIZE, FrameMonitor } from './frameMonitor';
import { setPerfLogSink } from './logger';
import {
  registerEntity,
  resetEntityRegistry,
  unregisterEntity,
} from '@client/world/entity-registry';

describe('frameMonitor rolling window (TASK-57)', () => {
  let monitor: FrameMonitor;

  beforeEach(() => {
    monitor = new FrameMonitor();
    resetEntityRegistry();
  });

  it('computes p50/p95/p99 of known sequences (nearest-rank)', () => {
    // 1..100 → p50=50, p95=95, p99=99.
    for (let t = 0; t < 100; t++) {
      monitor.beginFrame(t * 16.67);
      monitor.endFrame(null, t * 16.67 + t + 1);
    }
    // Re-derive the percentiles over the exact window contents: frame i
    // took (i+1) ms, so the window holds 1..100 in order.
    const stats = monitor.getFrameStats();
    expect(stats.frameTimeP50Ms).toBeCloseTo(50, 5);
    expect(stats.frameTimeP95Ms).toBeCloseTo(95, 5);
    expect(stats.frameTimeP99Ms).toBeCloseTo(99, 5);
  });

  it('p95 of a small known sequence', () => {
    const frameTimes = [20, 4, 10, 8, 6, 12, 14, 16, 18, 2];
    let t = 0;
    for (const ms of frameTimes) {
      monitor.beginFrame(t);
      monitor.endFrame(null, (t += ms));
    }
    const stats = monitor.getFrameStats();
    // sorted: 2 4 6 8 10 12 14 16 18 20 → rank ceil(0.95*10)=10 → 20
    expect(stats.frameTimeP95Ms).toBeCloseTo(20, 5);
    expect(stats.frameTimeP50Ms).toBeCloseTo(10, 5); // rank ceil(5)=5 → 10
    expect(stats.frameTimeP99Ms).toBeCloseTo(20, 5);
  });

  it('keeps only the last FRAME_WINDOW_SIZE frames', () => {
    // 350 frames of 1 ms, then 50 frames of 100 ms → the window (300)
    // holds the tail 250×1 ms + 50×100 ms, so p95 is 100, not 1.
    let t = 0;
    for (let i = 0; i < 350; i++) {
      monitor.beginFrame(t);
      monitor.endFrame(null, (t += 1));
    }
    for (let i = 0; i < 50; i++) {
      monitor.beginFrame(t);
      monitor.endFrame(null, (t += 100));
    }
    expect(monitor.getFrameStats().frameTimeP95Ms).toBeCloseTo(100, 5);
    expect(FRAME_WINDOW_SIZE).toBe(300);
  });

  it('counts FPS over a 1 s window of frame-end timestamps', () => {
    // 120 frames at 500 fps (2 ms apart) → the 1 s window holds 200 max,
    // here only the 60 pushed → fps 60.
    let t = 0;
    for (let i = 0; i < 60; i++) {
      monitor.beginFrame(t);
      monitor.endFrame(null, (t += 2));
    }
    expect(monitor.getFrameStats().fps).toBe(60);

    // 40 more frames 3 s later: only those are inside the fresh window.
    t += 3000;
    for (let i = 0; i < 40; i++) {
      monitor.beginFrame(t);
      monitor.endFrame(null, (t += 2));
    }
    expect(monitor.getFrameStats().fps).toBe(40);
  });

  it('captures renderer info (draw calls + triangles) from the last frame', () => {
    monitor.beginFrame(0);
    monitor.endFrame({ drawCalls: 7, triangles: 42_000 }, 16.7);
    const stats = monitor.getFrameStats();
    expect(stats.drawCalls).toBe(7);
    expect(stats.triangles).toBe(42_000);
  });

  it('reports the entity registry count in stats', () => {
    registerEntity('ship-1', 'ship');
    registerEntity('char-1', 'character');
    registerEntity('wreck-1', 'wreck');
    expect(monitor.getFrameStats().entities).toBe(3);
    unregisterEntity('ship-1');
    expect(monitor.getFrameStats().entities).toBe(2);
  });
});

describe('frameMonitor budgetCheck (TASK-57)', () => {
  let monitor: FrameMonitor;
  let warned: Array<{ message: string; meta?: Record<string, unknown> }>;
  let now: number;

  beforeEach(() => {
    monitor = new FrameMonitor();
    warned = [];
    now = 1_000_000;
    setPerfLogSink((message, meta) => warned.push({ message, meta }));
  });

  afterEach(() => setPerfLogSink(null)); // restore the default console sink

  it('stays silent while under budget and tracks the rolling max', () => {
    monitor.registerBudget('world-swap', 300);
    monitor.budgetCheck('world-swap', 120, now);
    monitor.budgetCheck('world-swap', 250, now + 1000);
    expect(warned).toEqual([]);
    expect(monitor.getBudgetStats('world-swap')).toEqual({
      budgetMs: 300,
      maxMs: 250,
      warnings: 0,
    });
  });

  it('warns when the budget is exceeded', () => {
    monitor.registerBudget('world-swap', 300);
    monitor.budgetCheck('world-swap', 412.5, now);
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toContain('"world-swap"');
    expect(warned[0].message).toContain('412.50');
    expect(warned[0].message).toContain('300');
    expect(monitor.getBudgetStats('world-swap').warnings).toBe(1);
  });

  it('warns at most once per name per 10 s', () => {
    monitor.registerBudget('streaming', 5);
    monitor.budgetCheck('streaming', 9, now);
    monitor.budgetCheck('streaming', 12, now + 5_000); // inside cooldown
    monitor.budgetCheck('streaming', 11, now + BUDGET_WARN_COOLDOWN_MS - 1); // still inside
    expect(warned).toHaveLength(1);
    monitor.budgetCheck('streaming', 13, now + BUDGET_WARN_COOLDOWN_MS); // boundary: 10 s elapsed
    expect(warned).toHaveLength(2);
  });

  it('rate-limits per name independently', () => {
    monitor.registerBudget('a', 1);
    monitor.registerBudget('b', 1);
    monitor.budgetCheck('a', 2, now);
    monitor.budgetCheck('b', 2, now);
    expect(warned).toHaveLength(2);
  });

  it('warns (rate-limited) when no budget is registered for the name', () => {
    monitor.budgetCheck('unregistered', 5, now);
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toContain('no budget is registered');
    monitor.budgetCheck('unregistered', 6, now + 1);
    expect(warned).toHaveLength(1);
  });

  it('reset clears budgets and telemetry', () => {
    monitor.registerBudget('x', 1);
    monitor.budgetCheck('x', 2, now);
    monitor.reset();
    monitor.budgetCheck('x', 2, now); // name has no budget now → missing-budget warn
    const after = monitor.getBudgetStats('x');
    expect(after.budgetMs).toBeNull();
    expect(after.maxMs).toBe(2);
    expect(after.warnings).toBe(1);
  });
});

describe('frameMonitor gauges + categories (TASK-26)', () => {
  let monitor: FrameMonitor;
  let warned: Array<{ message: string; meta?: Record<string, unknown> }>;
  let now: number;

  beforeEach(() => {
    monitor = new FrameMonitor();
    warned = [];
    now = 2_000_000;
    setPerfLogSink((message, meta) => warned.push({ message, meta }));
  });

  afterEach(() => setPerfLogSink(null)); // restore the default console sink

  it('stays silent under the gauge limit and tracks the rolling max', () => {
    monitor.registerGauge('surface-tris', 400_000);
    monitor.gaugeCheck('surface-tris', 90_138, now);
    monitor.gaugeCheck('surface-tris', 399_999, now + 500);
    expect(warned).toEqual([]);
    expect(monitor.getGaugeStats('surface-tris')).toEqual({
      limit: 400_000,
      maxValue: 399_999,
      warnings: 0,
    });
  });

  it('warns when the gauge limit is exceeded', () => {
    monitor.registerGauge('surface-tris', 400_000);
    monitor.gaugeCheck('surface-tris', 412_000, now);
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toContain('"surface-tris"');
    expect(warned[0].message).toContain('412000');
    expect(warned[0].message).toContain('400000');
    expect(monitor.getGaugeStats('surface-tris').warnings).toBe(1);
  });

  it('rate-limits gauge warnings to one per 10 s (same mechanism as budgets)', () => {
    monitor.registerGauge('surface-tris', 1_000);
    monitor.gaugeCheck('surface-tris', 2_000, now);
    monitor.gaugeCheck('surface-tris', 3_000, now + BUDGET_WARN_COOLDOWN_MS - 1);
    expect(warned).toHaveLength(1);
    monitor.gaugeCheck('surface-tris', 3_000, now + BUDGET_WARN_COOLDOWN_MS);
    expect(warned).toHaveLength(2);
  });

  it('warns (rate-limited) when no limit is registered for the gauge', () => {
    monitor.gaugeCheck('unregistered-gauge', 42, now);
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toContain('no limit is registered');
    monitor.gaugeCheck('unregistered-gauge', 43, now + 1);
    expect(warned).toHaveLength(1);
  });

  it('reportCategories replaces the per-frame category tally in the stats snapshot', () => {
    monitor.reportCategories({ 'surface-near': 81_920, 'surface-mid': 8_192, 'surface-far': 26 });
    expect(monitor.getFrameStats().categoryTriangles).toEqual({
      'surface-near': 81_920,
      'surface-mid': 8_192,
      'surface-far': 26,
    });
    monitor.reportCategories({ 'surface-near': 0 }); // replaced, not merged
    expect(monitor.getFrameStats().categoryTriangles).toEqual({ 'surface-near': 0 });
  });

  it('reset clears gauges, warnings, and categories', () => {
    monitor.registerGauge('surface-tris', 100);
    monitor.gaugeCheck('surface-tris', 200, now);
    monitor.reportCategories({ 'surface-far': 4 });
    monitor.reset();
    expect(monitor.getGaugeStats('surface-tris')).toEqual({
      limit: null,
      maxValue: 0,
      warnings: 0,
    });
    expect(monitor.getFrameStats().categoryTriangles).toEqual({});
  });
});

describe('frameMonitor overhead (TASK-57)', () => {
  it('monitor API cost per frame is a negligible fraction of a 1 ms frame budget', () => {
    const monitor = new FrameMonitor();
    const N = 60_000; // ~1000 s of 60 fps frames
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      monitor.beginFrame();
      monitor.endFrame({ drawCalls: 10, triangles: 50_000 });
      if (i % 30 === 0) monitor.getFrameStats(); // overlay cadence (2 Hz ≈ every 30th frame)
    }
    const totalMs = performance.now() - t0;
    const perFrameMs = totalMs / N;
    // Recorded in the test log: must stay far below 1 ms — the overlay's
    // real p95 impact is even smaller (the 2 Hz DOM poll is separate).
    expect(perFrameMs).toBeLessThan(0.1);
    console.log(`[perf] frameMonitor per-frame overhead: ${(perFrameMs * 1000).toFixed(2)} µs`);
  });

  // The full acceptance criterion (toggling the overlay changes p95 frame
  // time by < 1 ms in a headless render) needs a live GL context. The
  // vitest suite runs in a plain node environment with no DOM/WebGL —
  // headless GL is only available in the Playwright harness (SwiftShader,
  // TASK-70 findings) — so the render A/B benchmark is documented-skip
  // here; the per-frame API cost above bounds the monitor's own overhead,
  // and the e2e (tests/e2e/frame-monitor.spec.ts) exercises the overlay
  // on the live SwiftShader-rendered scene.
  const glAvailable =
    typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl2');
  (glAvailable ? describe : describe.skip)('overlay overhead A/B (live headless GL)', () => {
    it('toggling the overlay changes p95 by < 1 ms', () => {
      throw new Error('benchmark requires the Playwright harness — see spec note');
    });
  });
});
