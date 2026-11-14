import { describe, expect, it } from 'vitest';
import { FakeTimers } from '../testing/fakeTimers.ts';
import { SimLoop } from './simLoop.ts';

/** A loop on fake time; returns the loop, its timers and the ticks it ran. */
function setup(maxCatchUp?: number) {
  const timers = new FakeTimers(0);
  const ticks: number[] = [];
  const loop = new SimLoop({
    tickMs: 50,
    now: timers.now,
    timers,
    onTick: (tick) => ticks.push(tick),
    ...(maxCatchUp === undefined ? {} : { maxCatchUp }),
  });
  return { timers, ticks, loop };
}

describe('SimLoop', () => {
  it('runs exactly one tick per 50 ms of time, with no drift over 1000 ticks', () => {
    const { timers, ticks, loop } = setup();
    loop.start();
    // Irregular wake-ups: the accumulator must still produce exactly elapsed / 50 ticks.
    let elapsed = 0;
    for (let i = 0; elapsed < 50_000; i++) {
      const step = Math.min(7 + ((i * 13) % 31), 50_000 - elapsed);
      timers.advance(step);
      elapsed += step;
    }
    expect(ticks.length).toBe(1000);
    expect(ticks[999]).toBe(1000);
    expect(loop.droppedMs).toBe(0);
  });

  it('catches up at most 5 ticks after a stall and drops the rest', () => {
    const { timers, ticks, loop } = setup();
    loop.start();
    loop.stop(); // drive pump by hand
    const manual = new SimLoop({
      tickMs: 50,
      now: timers.now,
      timers,
      onTick: (t) => ticks.push(t),
    });
    manual.pump();
    timers.advance(1000); // a 20-tick stall
    expect(manual.pump()).toBe(5);
    expect(manual.droppedMs).toBe(750);
    timers.advance(50);
    expect(manual.pump()).toBe(1);
  });

  it('starts and stops idempotently and reports tick-duration percentiles', () => {
    const timers = new FakeTimers(0);
    let now = 0;
    const loop = new SimLoop({
      tickMs: 50,
      now: () => now,
      timers,
      onTick: (tick) => {
        now += tick % 10 === 0 ? 4 : 1; // every tenth tick is slow
      },
    });
    expect(loop.percentile(0.95)).toBe(0);
    loop.start();
    loop.start();
    expect(loop.running).toBe(true);
    expect(timers.pending).toBe(1);
    for (let i = 0; i < 100; i++) {
      now += 50;
      loop.pump();
    }
    expect(loop.percentile(0.5)).toBe(1);
    expect(loop.percentile(0.95)).toBe(4);
    loop.stop();
    loop.stop();
    expect(loop.running).toBe(false);
    expect(timers.pending).toBe(0);
  });
});
