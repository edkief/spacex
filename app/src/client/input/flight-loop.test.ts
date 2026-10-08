import { describe, expect, it } from 'vitest';

import type { ShipInput } from '@shared/physics/flight';
import type { Regime } from '@shared/regime';

import { CONTROL_SCHEMES, readSchemeInput } from './controls';
import {
  INPUT_SEND_PERIOD_MS,
  InputFrameSender,
  anyFlightDemand,
  dockedFlightScheme,
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

/**
 * TASK-86: the flight loop's per-frame decision for the SELF ship, as the
 * loop composes it (main.tsx flight body): read the pressed keys through
 * the scheme the loop uses for this frame (a FLIGHT scheme while
 * wire-docked — TASK-86 — else the remapper's active scheme), apply the
 * TASK-78 dock gate (while wire-docked only a NON-ZERO demand may send —
 * an idle frame would be the server's "first input" and launch the frozen
 * ship), and stamp the shared monotonic seq on whatever goes out.
 */
function loopFrame(
  sender: InputFrameSender,
  nowMs: number,
  pressed: string[],
  opts: { docked: boolean; activeRegime: Regime },
): { seq: number | null; input: ShipInput } {
  const scheme = opts.docked
    ? dockedFlightScheme(opts.activeRegime)
    : CONTROL_SCHEMES[opts.activeRegime];
  const input = readSchemeInput(scheme, new Set(pressed));
  const nonzero = anyFlightDemand(input);
  const seq = !opts.docked || nonzero ? sender.shouldSend(nowMs, shipInputKey(input)) : null;
  return { seq, input };
}

describe('docked undock contract (TASK-86)', () => {
  it('a pad-docked ship (wire-docked, regime surface) takes off on its first W', () => {
    const s = new InputFrameSender();
    // Idle while docked: zero demand → the frame is suppressed (TASK-78).
    const idle = loopFrame(s, 0, [], { docked: true, activeRegime: 'surface' });
    expect(idle.seq).toBeNull();
    // The FIRST real flight input (W held): the loop must send a frame with
    // a fresh seq — the server clears entity.docked on its first input.
    // RED pre-fix: the surface (character) scheme read W as a walk, every
    // flight channel stayed 0, and the dock gate suppressed the frame —
    // the ship could never take off.
    const first = loopFrame(s, INPUT_SEND_PERIOD_MS, ['w'], {
      docked: true,
      activeRegime: 'surface',
    });
    expect(first.input.thrust).toBe(1);
    expect(first.seq).toBe(1);
  });

  it('a home-dock ship (wire-docked, regime space) still undocks on W', () => {
    const s = new InputFrameSender();
    const first = loopFrame(s, INPUT_SEND_PERIOD_MS, ['w'], {
      docked: true,
      activeRegime: 'space',
    });
    expect(first.input.thrust).toBe(1);
    expect(first.seq).toBe(1);
  });

  it('TASK-78 invariant: a zero-demand frame while wire-docked sends NOTHING', () => {
    const s = new InputFrameSender();
    for (let i = 0; i < 10; i++) {
      // 10 consecutive idle frames at 20 Hz (past the cadence boundary the
      // sender would re-send a held frame): while docked, none may go out.
      const f = loopFrame(s, i * INPUT_SEND_PERIOD_MS, [], {
        docked: true,
        activeRegime: 'surface',
      });
      expect(f.seq).toBeNull();
    }
    expect(s.seq).toBe(0); // the counter never moved
    // The same idle frames with the wire UN-docked DO send (normal coast
    // frames keep the server's held-frame fresh).
    const coast = loopFrame(s, 10 * INPUT_SEND_PERIOD_MS, [], {
      docked: false,
      activeRegime: 'space',
    });
    expect(coast.seq).toBe(1);
  });

  it('after the undock frame the seq continues with no gap and no repeat', () => {
    const s = new InputFrameSender();
    const w = loopFrame(s, 0, ['w'], { docked: true, activeRegime: 'surface' });
    expect(w.seq).toBe(1);
    // The wire flips: the next frame (still holding W, now undocked) must
    // be a fresh, higher seq — the shared counter carries over.
    const next = loopFrame(s, INPUT_SEND_PERIOD_MS, ['w'], {
      docked: false,
      activeRegime: 'atmosphere',
    });
    expect(next.seq).toBe(2);
    // Releasing W while undocked sends the coast frame (key change).
    const release = loopFrame(s, INPUT_SEND_PERIOD_MS * 2, [], {
      docked: false,
      activeRegime: 'atmosphere',
    });
    expect(release.seq).toBe(3);
    expect(s.seq).toBe(3);
  });

  it('dockedFlightScheme maps surface→atmosphere, others to themselves', () => {
    expect(dockedFlightScheme('surface')).toBe(CONTROL_SCHEMES.atmosphere);
    expect(dockedFlightScheme('space')).toBe(CONTROL_SCHEMES.space);
    expect(dockedFlightScheme('atmosphere')).toBe(CONTROL_SCHEMES.atmosphere);
    // The atmosphere scheme carries the VTOL lift key — the pad take-off
    // the server answers with its first-input rule.
    expect(dockedFlightScheme('surface').vtol).toBe(' ');
    // And W reads as a real thrust demand through it (the pre-fix zero).
    expect(anyFlightDemand(readSchemeInput(dockedFlightScheme('surface'), new Set(['w'])))).toBe(
      true,
    );
  });
});
