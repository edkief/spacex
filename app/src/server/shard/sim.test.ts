import { afterEach, describe, expect, it, vi } from 'vitest';

import { SimLoop } from '@server/shard/sim';

/**
 * SimLoop unit tests (TASK-13, step 1): fixed-timestep accumulator with drift
 * correction, bounded catch-up, input-drop signalling. All timing via fake
 * timers — no wall clock involved.
 */

afterEach(() => {
  vi.useRealTimers();
});

/**
 * `fakeClock: false` → the loop uses Date.now (paired with vi fake timers);
 * `fakeClock: true` → a controlled clock starting at 0 for direct step() math.
 */
function makeLoop(dtMs = 50, maxCatchUp = 5, fakeClock = false) {
  const ticks: number[] = [];
  const t = 0;
  const loop = new SimLoop({
    dtMs,
    maxCatchUpTicks: maxCatchUp,
    onTick: (tick) => {
      ticks.push(tick);
    },
    now: fakeClock ? () => t : undefined,
  });
  return { loop, ticks };
}

describe('SimLoop accumulator (TASK-13)', () => {
  it('first tick fires exactly one dt after start', () => {
    vi.useFakeTimers();
    const { loop, ticks } = makeLoop(50);
    loop.start();
    vi.advanceTimersByTime(49);
    expect(ticks).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ticks).toEqual([1]);
    loop.stop();
  });

  it('no drift over 1000 ticks at exact dt steps', () => {
    vi.useFakeTimers();
    const { loop, ticks } = makeLoop(50);
    loop.start();
    for (let i = 0; i < 1000; i++) {
      vi.advanceTimersByTime(50);
      expect(ticks.length).toBe(i + 1); // exactly one tick per step, every step
    }
    // Tick number and elapsed wall time agree: 1000 ticks = 50 000 ms, no
    // fractional remainder accumulated (drift correction keeps the anchor).
    expect(ticks).toHaveLength(1000);
    expect(loop.tickNumber).toBe(1000);
    expect(ticks[999]).toBe(1000);
    vi.advanceTimersByTime(49);
    expect(ticks).toHaveLength(1000); // nothing owed yet
    vi.advanceTimersByTime(1);
    expect(ticks).toHaveLength(1001);
    loop.stop();
  });

  it('absorbs timer jitter without accumulating drift', () => {
    vi.useFakeTimers();
    const { loop, ticks } = makeLoop(50);
    loop.start();
    // 55 ms wall steps: 10 % of each step is "late" and would drift a naive
    // setInterval-style loop by 11 s per 100 s.
    for (let i = 1; i <= 1000; i++) {
      vi.advanceTimersByTime(55);
    }
    const expected = Math.floor(55_000 / 50); // 1100 ticks owed
    // Within one tick of the ideal count: no cumulative drift.
    expect(ticks.length).toBeGreaterThanOrEqual(expected - 1);
    expect(ticks.length).toBeLessThanOrEqual(expected + 1);
    loop.stop();
  });

  it('catches up after a stall (4 owed ticks in one burst)', () => {
    // Direct accumulator steps: the event loop stalled, so at t=250 four
    // ideal tick times (100..250) are all owed at once.
    const { loop, ticks } = makeLoop(50, 5, true);
    // (loop clock starts at 0: start() anchors the first tick at t=50;
    // stop() disarms the real timer so only explicit steps advance)
    loop.start();
    loop.stop();
    expect(loop.step(50)).toBe(1); // on-time
    expect(loop.step(250)).toBe(4); // 4 owed → all 4 run in one burst
    expect(ticks).toEqual([1, 2, 3, 4, 5]);
    expect(loop.inputDrops).toBe(false);
    expect(loop.step(300)).toBe(1);
    loop.stop();
  });

  it('caps catch-up at 5 ticks and signals input drops until on-time', () => {
    const { loop, ticks } = makeLoop(50, 5, true);
    loop.start();
    loop.stop();
    expect(loop.step(50)).toBe(1);
    // Event loop stalled 300 ms: 6 ticks owed, only 5 may run (max catch-up),
    // the 6th is skipped so the loop never spirals of death.
    expect(loop.step(350)).toBe(5);
    expect(ticks).toHaveLength(6);
    expect(loop.inputDrops).toBe(true); // stale-input protection engages
    expect(loop.step(400)).toBe(1); // on-time again clears the drop window
    expect(ticks).toHaveLength(7);
    expect(loop.inputDrops).toBe(false);
  });

  it('stop halts ticking and start resumes the tick counter', () => {
    vi.useFakeTimers();
    const { loop, ticks } = makeLoop(50);
    loop.start();
    vi.advanceTimersByTime(150);
    expect(ticks).toEqual([1, 2, 3]);
    loop.stop();
    expect(loop.isRunning).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(ticks).toEqual([1, 2, 3]); // frozen while stopped
    loop.start();
    vi.advanceTimersByTime(50);
    expect(ticks).toEqual([1, 2, 3, 4]); // continues, does not restart
    loop.stop();
  });
});
