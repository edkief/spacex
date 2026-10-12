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
  flightLoopScheme,
  shipInputKey,
} from './flight-loop';

/**
 * TASK-73: the shared input plumbing the ship + on-foot loops build on.
 * The server drops `seq <= conn.lastSeq` PER CONNECTION, so the counter
 * must stay strictly monotonic across regime transitions (ship → on-foot
 * → ship) — a second counter (or a reset) would make a frame in flight
 * from the previous regime arrive stale and get silently dropped.
 */

/**
 * TASK-104: the PURE-period cadence contract. A frame is due only when
 * INPUT_SEND_PERIOD_MS has elapsed since the last send — the key never
 * bypasses the period. (The old key-change bypass let the analog touch
 * sticks' per-frame key changes stream 'input' at frame rate into the
 * server's 20 msg/s inbound bucket → 4009 kicks on touch.)
 */
describe('InputFrameSender (TASK-104 pure-period cadence)', () => {
  it('first frame always sends (t=0)', () => {
    const s = new InputFrameSender();
    expect(s.seq).toBe(0);
    // The NEGATIVE_INFINITY init makes the first call due — the docked
    // 'first input = take-off' contract (TASK-78/86) depends on it: while
    // wire-docked the loop suppresses frames, lastSendMs goes stale, and
    // the player's first W must go out on the very next frame.
    expect(s.shouldSend(0)).toBe(1);
  });

  it('a key change INSIDE the period does NOT send (no bypass)', () => {
    const s = new InputFrameSender();
    expect(s.shouldSend(0)).toBe(1); // keyA at t=0
    // The analog touch sticks (TASK-99/100) change the key on EVERY
    // pointermove — pre-fix each change sent immediately (≈60-120 msg/s →
    // the 20 msg/s bucket kicked the socket 4009). Now nothing is due
    // inside the period, whatever the key is.
    expect(s.shouldSend(10)).toBeNull(); // keyB
    expect(s.shouldSend(65)).toBeNull(); // keyC — 65 = 66 ms period - 1
  });

  it('the period boundary re-sends even for the SAME key', () => {
    const s = new InputFrameSender();
    expect(s.shouldSend(0)).toBe(1);
    expect(s.shouldSend(65)).toBeNull();
    expect(s.shouldSend(66)).toBe(2); // 66 = the new INPUT_SEND_PERIOD_MS
  });

  it('a key change AT the boundary sends (one send, not two)', () => {
    const s = new InputFrameSender();
    expect(s.shouldSend(0)).toBe(1); // keyA at t=0
    // keyB at exactly the boundary: the period fires ONE send.
    expect(s.shouldSend(66)).toBe(2);
  });

  it('keeps ONE monotonic seq across ship → on-foot → ship (no resets)', () => {
    const s = new InputFrameSender();
    let now = 0;
    const send = (): number | null => {
      const seq = s.shouldSend(now);
      now += INPUT_SEND_PERIOD_MS;
      return seq;
    };
    // In the ship (flight key format from shipInputKey).
    expect(send()).toBe(1); // key '1|0|0|0|0'
    expect(send()).toBe(2); // key '1|1|0|0|0'
    expect(send()).toBe(3); // key '0|0|0|0|0'
    // Disembark → on foot (the on-foot loop's DIFFERENT key format). The
    // counter must continue, never restart — a restarted seq would be
    // stale (<= conn.lastSeq) and dropped by the server.
    expect(send()).toBe(4); // key '1|0|run'
    expect(send()).toBe(5); // key '1|0|'
    expect(send()).toBe(6); // key '0|0|'
    // Re-enter the ship: still monotonic.
    expect(send()).toBe(7); // key '1|0|0|0|0'
    expect(s.seq).toBe(7);
  });

  it('held frames across a regime switch never repeat a seq', () => {
    const s = new InputFrameSender();
    const seqs: number[] = [];
    let now = 0;
    for (const _key of ['0|0|0|0|0', '1|0|0|0|0', '1|0|', '1|0|0|0|0']) {
      for (let i = 0; i < 3; i++) {
        // 3 held sends per key (past the cadence boundary).
        const seq = s.shouldSend(now);
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
  it('every channel change produces a distinct key (stable wire-fingerprint)', () => {
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
  const seq = !opts.docked || nonzero ? sender.shouldSend(nowMs) : null;
  return { seq, input };
}

describe('hover channel + scheme selection (TASK-107)', () => {
  it('anyFlightDemand counts the hover channel (the dock gate must not swallow it)', () => {
    const zero: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0, boost: 0 };
    expect(anyFlightDemand(zero)).toBe(false);
    // Hover on with nothing else held IS a demand — while wire-docked it
    // must beat the TASK-78 idle-frame gate (first input = take-off).
    expect(anyFlightDemand({ ...zero, hover: 1 })).toBe(true);
    expect(anyFlightDemand({ ...zero, hover: 0 })).toBe(false);
  });

  it('shipInputKey distinguishes the hover channel (stable wire fingerprint)', () => {
    const base = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0, boost: 0 };
    expect(shipInputKey({ ...base, hover: 1 })).not.toBe(shipInputKey(base));
    // up + hover (the normalized 'hover' form) is distinct from up alone
    // (the legacy 'vtol' form) — the two lift sources never collide.
    expect(shipInputKey({ ...base, up: 1, hover: 1 })).not.toBe(shipInputKey({ ...base, up: 1 }));
  });

  it('flightLoopScheme: wire-docked OR in-ship surface reads the flight (atmosphere) scheme', () => {
    // TASK-86 rule: a pad-docked ship (wire 'surface', docked) and any
    // landed in-ship ship (wire 'surface') must read the atmosphere flight
    // scheme — W = thrust, Space = VTOL — not the character scheme.
    expect(flightLoopScheme('surface', true)).toBe(CONTROL_SCHEMES.atmosphere);
    expect(flightLoopScheme('surface', false)).toBe(CONTROL_SCHEMES.atmosphere);
    expect(flightLoopScheme('atmosphere', false)).toBe(CONTROL_SCHEMES.atmosphere);
    expect(flightLoopScheme('space', true)).toBe(CONTROL_SCHEMES.space);
    expect(flightLoopScheme('space', false)).toBe(CONTROL_SCHEMES.space);
  });

  it('the Space-hover toggle is live exactly where the loop reads Space as VTOL', () => {
    // The main.tsx keydown guard (scheme.vtol === ' ') — atmosphere and the
    // in-ship surface (dockedFlightScheme) toggle; space and on foot (the
    // character scheme) never do.
    expect(flightLoopScheme('atmosphere', false).vtol).toBe(' ');
    expect(flightLoopScheme('surface', false).vtol).toBe(' '); // dockedFlightScheme
    expect(flightLoopScheme('space', false).vtol).toBeNull();
    expect(CONTROL_SCHEMES.surface.vtol).toBeNull(); // on foot: Space = jump
  });
});

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
