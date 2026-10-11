import { describe, expect, it } from 'vitest';

import { shipInputToPayload } from '@shared/protocol/inputs';

import { CONTROL_SCHEMES, readSchemeInput } from './controls';
import { mergeAxis, mergeFlightInput, touchFlightAxes } from './touch';

/**
 * TASK-99 — the analog touch path: the ship loop merges the keyboard's
 * binary readout with the live stick magnitudes per axis, and the merged
 * analog ShipInput goes through the existing shipInputToPayload.
 */

const keys = (...list: string[]): Set<string> => new Set(list);

describe('mergeAxis — larger magnitude wins, keyboard wins ties', () => {
  it('same sign: the one with the larger absolute value', () => {
    expect(mergeAxis(0.5, 0.3)).toBe(0.5); // keyboard
    expect(mergeAxis(0.3, 0.5)).toBe(0.5); // touch
    expect(mergeAxis(-0.4, -0.9)).toBe(-0.9); // touch
    expect(mergeAxis(-0.9, -0.4)).toBe(-0.9); // keyboard
  });

  it('opposite signs: the larger |value|', () => {
    expect(mergeAxis(0.5, -0.8)).toBe(-0.8);
    expect(mergeAxis(-0.8, 0.5)).toBe(-0.8);
    expect(mergeAxis(0.9, -0.2)).toBe(0.9);
  });

  it('ties (equal magnitude, same or opposite sign) → keyboard', () => {
    expect(mergeAxis(0.5, 0.5)).toBe(0.5);
    expect(mergeAxis(-0.5, -0.5)).toBe(-0.5);
    expect(mergeAxis(0.5, -0.5)).toBe(0.5); // keyboard wins the opposition
    expect(mergeAxis(-0.5, 0.5)).toBe(-0.5);
  });

  it('zero on one side → the other; both zero → 0', () => {
    expect(mergeAxis(0, 0.7)).toBe(0.7);
    expect(mergeAxis(0.2, 0)).toBe(0.2);
    expect(mergeAxis(0, -0.2)).toBe(-0.2);
    expect(mergeAxis(0, 0)).toBe(0);
  });
});

describe('touchFlightAxes — the analog magnitudes, readSchemeInput sign parity', () => {
  it('each channel at ±1 lands on the SAME physics sign the equivalent key does', () => {
    const space = CONTROL_SCHEMES.space;
    const cases: Array<{ ch: Parameters<typeof touchFlightAxes>[1]; kb: string[] }> = [
      { ch: { thrust: 1 }, kb: ['w'] },
      { ch: { thrust: -1 }, kb: ['s'] },
      { ch: { yaw: 1 }, kb: ['d'] },
      { ch: { yaw: -1 }, kb: ['a'] },
      { ch: { pitch: 1 }, kb: ['f'] },
      { ch: { pitch: -1 }, kb: ['r'] },
      { ch: { roll: 1 }, kb: ['e'] },
      { ch: { roll: -1 }, kb: ['q'] },
    ];
    for (const { ch, kb } of cases) {
      const expected = readSchemeInput(space, keys(...kb));
      const got = touchFlightAxes(space, ch);
      expect(got, JSON.stringify(ch)).toEqual({
        thrust: expected.thrust,
        yaw: expected.yaw,
        pitch: expected.pitch,
        roll: expected.roll,
      });
    }
  });

  it('yaw=+1 (nose right) has the SAME physics sign as keyboard d (the TASK-80 negation)', () => {
    const space = CONTROL_SCHEMES.space;
    const byKey = readSchemeInput(space, keys('d')).yaw;
    expect(byKey).toBe(-1); // physics yaw + is a nose-LEFT turn
    expect(touchFlightAxes(space, { yaw: 1 }).yaw).toBe(byKey);
  });

  it('keeps the analog magnitude (thrust 0.5 → 0.5, yaw 0.7 → −0.7)', () => {
    const space = CONTROL_SCHEMES.space;
    expect(touchFlightAxes(space, { thrust: 0.5 })).toEqual({
      thrust: 0.5,
      yaw: 0,
      pitch: 0,
      roll: 0,
    });
    expect(touchFlightAxes(space, { yaw: 0.7 })).toEqual({
      thrust: 0,
      yaw: -0.7,
      pitch: 0,
      roll: 0,
    });
  });

  it('an absent channel reads as 0 (no −0 leak)', () => {
    const got = touchFlightAxes(CONTROL_SCHEMES.atmosphere, { vtol: true });
    expect(got).toEqual({ thrust: 0, yaw: 0, pitch: 0, roll: 0 });
    expect(Object.is(got.thrust, -0)).toBe(false);
  });

  it('the surface (character) scheme projects to zeros — no flight demand invented', () => {
    const surface = CONTROL_SCHEMES.surface;
    expect(touchFlightAxes(surface, { thrust: 1, yaw: 1, pitch: 1, roll: 1 })).toEqual({
      thrust: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
    });
  });
});

describe('mergeFlightInput — keyboard-only deep-equals the legacy readout (regression)', () => {
  it('space / atmosphere / docked (surface) schemes, no touch channels', () => {
    const keyCombos: Array<[keyof typeof CONTROL_SCHEMES, string[]]> = [
      ['space', ['w', 'd', 'f', 'e', 'Shift']],
      ['atmosphere', ['s', 'a', 'r', 'q', ' ']],
      ['surface', ['w', 's', 'a', 'd', 'e']],
    ];
    for (const [regime, combo] of keyCombos) {
      const scheme = CONTROL_SCHEMES[regime];
      const kb = readSchemeInput(scheme, keys(...combo));
      const merged = mergeFlightInput(kb, {}, scheme);
      expect(merged, regime).toEqual(kb);
    }
  });

  it('VTOL and boost stay the keyboard readout (button-driven, binary)', () => {
    const atmo = CONTROL_SCHEMES.atmosphere;
    const kb = readSchemeInput(atmo, keys(' '));
    const merged = mergeFlightInput(kb, { thrust: 0.9 }, atmo);
    expect(merged.up).toBe(kb.up); // 1 — the ' ' virtual key the touch button writes
    expect(merged.boost ?? 0).toBe(kb.boost ?? 0);
    expect(merged.thrust).toBe(0.9);
  });
});

describe('mergeFlightInput — merged analog magnitudes reach the wire payload', () => {
  it('channel thrust=0.5 with the keyboard idle → merged thrust 0.5', () => {
    const space = CONTROL_SCHEMES.space;
    const kb = readSchemeInput(space, keys());
    const merged = mergeFlightInput(kb, { thrust: 0.5 }, space);
    expect(merged.thrust).toBe(0.5);
    expect(merged.yaw).toBe(0);
  });

  it('keyboard-only: the payload is byte-for-byte the legacy readSchemeInput → shipInputToPayload one', () => {
    const space = CONTROL_SCHEMES.space;
    const kb = readSchemeInput(space, keys('w', 'd', 'Shift'));
    const legacy = shipInputToPayload(7, kb);
    const withMerge = shipInputToPayload(7, mergeFlightInput(kb, {}, space));
    expect(withMerge).toEqual(legacy);
  });

  it('with touch channels the payload thrust/yaw/pitch/turn carry the analog magnitudes', () => {
    const space = CONTROL_SCHEMES.space;
    const kb = readSchemeInput(space, keys('w', 'd')); // binary +1 thrust, +1→−1 yaw
    const merged = mergeFlightInput(kb, { thrust: 0.5, pitch: 0.25 }, space);
    const payload = shipInputToPayload(9, merged);
    expect(payload.thrust).toBe(1); // kb |1| > touch 0.5
    expect(payload.yaw).toBe(-1); // kb −1 (no touch yaw channel)
    expect(payload.pitch).toBe(-0.25); // touch nose-UP is physics-negative (TASK-80)
    expect(payload.turn).toBe(0);
  });

  it('touch magnitude larger than the keyboard → the stick wins the axis', () => {
    const space = CONTROL_SCHEMES.space;
    const kb = readSchemeInput(space, keys('s')); // thrust −1
    const merged = mergeFlightInput(kb, { thrust: -0.9 }, space);
    // equal-magnitude opposition would be a keyboard tie-win; here the
    // keyboard's |1| is strictly larger, so it holds:
    expect(merged.thrust).toBe(-1);
    const merged2 = mergeFlightInput(readSchemeInput(space, keys()), { thrust: -0.9 }, space);
    expect(merged2.thrust).toBe(-0.9);
  });
});
