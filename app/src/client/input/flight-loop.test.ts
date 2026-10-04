import { describe, expect, it } from 'vitest';

import {
  INPUT_SEND_PERIOD_MS,
  InputFrameSender,
  effectiveFlightPressed,
  shipInputKey,
} from './flight-loop';

/**
 * TASK-73: the shared input plumbing the ship + on-foot loops build on.
 * The server drops `seq <= conn.lastSeq` PER CONNECTION, so the counter
 * must stay strictly monotonic across regime transitions (ship → on-foot
 * → ship) — a second counter (or a reset) would make a frame in flight
 * from the previous regime arrive stale and get silently dropped.
 */

describe('InputFrameSender (TASK-73)', () => {
  it('sends on the first frame, on key change, and at 20 Hz while held', () => {
    const s = new InputFrameSender();
    expect(s.seq).toBe(0);
    expect(s.shouldSend(0, '1|0|0|0|0')).toBe(1);
    // Same key inside the period: nothing due (the server holds the frame).
    expect(s.shouldSend(1, '1|0|0|0|0')).toBeNull();
    expect(s.shouldSend(INPUT_SEND_PERIOD_MS - 1, '1|0|0|0|0')).toBeNull();
    // At the period boundary the held frame is re-sent.
    expect(s.shouldSend(INPUT_SEND_PERIOD_MS, '1|0|0|0|0')).toBe(2);
    // A key change fires immediately regardless of the clock.
    expect(s.shouldSend(INPUT_SEND_PERIOD_MS + 1, '0|0|0|0|0')).toBe(3);
  });

  it('keeps ONE monotonic seq across ship → on-foot → ship (no resets)', () => {
    const s = new InputFrameSender();
    let now = 0;
    const send = (key: string): number | null => {
      const seq = s.shouldSend(now, key);
      now += INPUT_SEND_PERIOD_MS;
      return seq;
    };
    // In the ship (flight key format from shipInputKey).
    expect(send('1|0|0|0|0')).toBe(1);
    expect(send('1|1|0|0|0')).toBe(2);
    expect(send('0|0|0|0|0')).toBe(3);
    // Disembark → on foot (the on-foot loop's DIFFERENT key format). The
    // counter must continue, never restart — a restarted seq would be
    // stale (<= conn.lastSeq) and dropped by the server.
    expect(send('1|0|run')).toBe(4);
    expect(send('1|0|')).toBe(5);
    expect(send('0|0|')).toBe(6);
    // Re-enter the ship: still monotonic.
    expect(send('1|0|0|0|0')).toBe(7);
    expect(s.seq).toBe(7);
  });

  it('held frames across a regime switch never repeat a seq', () => {
    const s = new InputFrameSender();
    const seqs: number[] = [];
    let now = 0;
    for (const key of ['0|0|0|0|0', '1|0|0|0|0', '1|0|', '1|0|0|0|0']) {
      for (let i = 0; i < 3; i++) {
        // 3 held sends per key (past the cadence boundary).
        const seq = s.shouldSend(now, key);
        if (seq !== null) seqs.push(seq);
        now += INPUT_SEND_PERIOD_MS;
      }
    }
    const seen = new Set(seqs);
    expect(seen.size).toBe(seqs.length); // no seq ever reused
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });
});

describe('effectiveFlightPressed (TASK-73)', () => {
  it('the open star chart never flies the ship (empty effective set)', () => {
    const pressed = new Set(['w', 'd', ' ']);
    expect(effectiveFlightPressed(pressed, { chartOpen: true })).toEqual(new Set());
    // The CAPTURED set is untouched — the keys are still physically held
    // and resume driving the ship when the chart closes.
    expect([...pressed]).toEqual(['w', 'd', ' ']);
  });

  it('chart closed: the pressed set passes through unchanged', () => {
    const pressed = new Set(['w']);
    expect(effectiveFlightPressed(pressed, { chartOpen: false })).toBe(pressed);
  });
});

describe('shipInputKey (TASK-73)', () => {
  it('every channel change produces a distinct key (the cadence trigger)', () => {
    const zero = shipInputKey({ thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 });
    expect(shipInputKey({ thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0 })).not.toBe(zero);
    expect(shipInputKey({ thrust: 0, yaw: 1, pitch: 0, roll: 0, up: 0 })).not.toBe(zero);
    expect(shipInputKey({ thrust: 0, yaw: 0, pitch: 1, roll: 0, up: 0 })).not.toBe(zero);
    expect(shipInputKey({ thrust: 0, yaw: 0, pitch: 0, roll: 1, up: 0 })).not.toBe(zero);
    expect(shipInputKey({ thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1 })).not.toBe(zero);
    expect(shipInputKey({ thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 1 })).not.toBe(
      shipInputKey({ thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0 }),
    );
  });
});
