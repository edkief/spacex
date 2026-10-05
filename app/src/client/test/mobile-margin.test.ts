/**
 * TASK-59 AC-3: the machine-independent 1.5x frame-time MARGIN check — the
 * benchmark scene runs at the High profile (60 fps budget) and the Mobile
 * profile (30 fps budget, forced) on the same headless scene, and
 * margin(mobile) ≥ 1.5 × margin(high) where margin = budget − median frame
 * time. Unpaced (raw main-thread work, ~300 frames each) so the suite stays
 * fast; `npm run bench:mobile` records the 600-frame numbers for TASK-61.
 */
import { describe, expect, it } from 'vitest';

import { runRenderBenchmark } from './renderBenchmark';

const HIGH_BUDGET_MS = 1000 / 60;
const MOBILE_BUDGET_MS = 1000 / 30;

describe('mobile floor: the 1.5x frame-time margin (AC-3, headless proxy)', () => {
  it('holds ≥ 1.5x the margin of the High profile on the AC-1 scene', () => {
    const high = runRenderBenchmark({ frames: 300, profile: 'high', paceToRealTime: false });
    const mobile = runRenderBenchmark({ frames: 300, profile: 'mobile', paceToRealTime: false });

    // Sanity: both scenes actually ran.
    expect(high.drawCallsMax).toBeGreaterThan(20);
    expect(mobile.drawCallsMax).toBeGreaterThan(20);
    // The mobile profile actually cut the scene (3 km radii → fewer chunks,
    // 2000 stars, 8 labels, no trail ribbons).
    expect(mobile.drawCallsP95).toBeLessThan(high.drawCallsP95);

    const highMargin = HIGH_BUDGET_MS - high.p50Ms;
    const mobileMargin = MOBILE_BUDGET_MS - mobile.p50Ms;
    expect(mobileMargin).toBeGreaterThanOrEqual(1.5 * highMargin);
  }, 120_000);

  it('the mobile profile still holds the no-spike rule', () => {
    const mobile = runRenderBenchmark({ frames: 300, profile: 'mobile', paceToRealTime: false });
    expect(mobile.spikes50Ms).toBe(0);
  }, 120_000);
});
