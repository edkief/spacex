import { describe, expect, it } from 'vitest';

import { FIRE_HOLD_MIN_INTERVAL_MS, FirePacer } from './use-fire-hold';

/**
 * TASK-104: the touch FIRE hold pacer. Pre-fix the rAF loop called onFire
 * once per frame (≈60-120 'fire' WS messages/s), the second of the two
 * frame-rate paths that flooded the server's 20 msg/s inbound bucket and
 * got the socket 4009-kicked on touch devices. The pacer caps intents at
 * one per FIRE_HOLD_MIN_INTERVAL_MS (≈ the laser's 3/s fireRate — the
 * server remains the rate AUTHORITY and re-derives the weapon cooldown, so
 * slower weapons like the 0.5/s missile are simply deduped server-side).
 *
 * The pacer is DOM-free and clock-injected, so its whole behaviour is
 * unit-testable here.
 */
describe('FirePacer (TASK-104)', () => {
  it('exposes the default 333 ms interval (≈ the laser 3/s fireRate)', () => {
    expect(FIRE_HOLD_MIN_INTERVAL_MS).toBe(333);
  });

  it('the first due() at t=0 is true (the immediate first shot on press)', () => {
    let t = 0;
    const p = new FirePacer(FIRE_HOLD_MIN_INTERVAL_MS, () => t);
    expect(p.due()).toBe(true);
  });

  it('a 2 s window sampled at 60 Hz yields 7-8 fires', () => {
    let t = 0;
    const p = new FirePacer(FIRE_HOLD_MIN_INTERVAL_MS, () => t);
    let fires = 0;
    for (let i = 0; i <= 60 * 2; i++) {
      if (p.due()) fires++;
      t += 1000 / 60;
    }
    // t = 0, 333, 666, 999, 1332, 1665, 1998 → 7 (the band tolerates a
    // frame landing exactly on the 2 s boundary).
    expect(fires).toBeGreaterThanOrEqual(7);
    expect(fires).toBeLessThanOrEqual(8);
  });

  it('a 2 s window sampled at 120 Hz yields the SAME count (frame-rate independence)', () => {
    const count = (hz: number): number => {
      let t = 0;
      const p = new FirePacer(FIRE_HOLD_MIN_INTERVAL_MS, () => t);
      let fires = 0;
      for (let i = 0; i <= hz * 2; i++) {
        if (p.due()) fires++;
        t += 1000 / hz;
      }
      return fires;
    };
    expect(count(120)).toBe(count(60));
  });

  it('a call inside the interval returns false and does not move the clock', () => {
    let t = 0;
    const p = new FirePacer(FIRE_HOLD_MIN_INTERVAL_MS, () => t);
    expect(p.due()).toBe(true); // t=0, last=0
    t = 100;
    expect(p.due()).toBe(false); // inside the interval
    // The rejected call must NOT have advanced the clock: the next due is
    // at 333 (measured from the last ACCEPTED send), not at 100 + 333.
    t = 333;
    expect(p.due()).toBe(true);
  });
});
