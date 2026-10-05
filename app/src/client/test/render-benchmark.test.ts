import { describe, expect, it } from 'vitest';

import { runRenderBenchmark } from './renderBenchmark';

/**
 * TASK-58 AC-6: the fast CI version of the render benchmark — 10 s of the
 * AC-1 scene (600 frames), asserts the NO-SPIKE RULE ONLY (zero frames over
 * 50 ms) so it stays green on any machine (the absolute budgets and the
 * delta target are checked by `npm run bench:render` on the dev machine,
 * and on reference hardware by TASK-61).
 */
describe('render benchmark (10 s CI version)', () => {
  it('holds the no-spike rule over 600 frames of the AC-1 combat scene', () => {
    const report = runRenderBenchmark({ frames: 600, tuned: true });

    expect(report.frames).toBe(600);
    // The no-spike rule: ZERO frames strictly over 50 ms (AC-2).
    expect(report.spikes50Ms).toBe(0);
    // Sanity: the scene actually ran (16 ships + 13 chunks + FX all present).
    expect(report.drawCallsMax).toBeGreaterThan(20);
    expect(report.trianglesMax).toBeGreaterThan(10_000);
    expect(report.maxLaserFlashes).toBeGreaterThan(0);
  }, 120_000);
});
