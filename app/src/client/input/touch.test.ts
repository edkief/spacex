import { describe, expect, it } from 'vitest';

import { CONTROL_SCHEMES, readSchemeInput } from './controls';
import { TouchInputSource, mergePressed, type TouchChannels } from './touch';

/** The exact keys the on-foot loop in main.tsx reads off the pressed set. */
const ON_FOOT_KEYS = ['w', 'a', 's', 'd', 'Shift', ' '];

const keys = (...list: string[]): Set<string> => new Set(list);

describe('TouchInputSource — single held channel → one virtual key', () => {
  const projects = (ch: TouchChannels): string[] => {
    const t = new TouchInputSource();
    t.setChannel(ch);
    return [...t.virtualKeys()].sort();
  };

  it('thrust + / − maps to w / s', () => {
    expect(projects({ thrust: 1 })).toEqual(['w']);
    expect(projects({ thrust: -1 })).toEqual(['s']);
    expect(projects({ thrust: 0.3 })).toEqual(['w']);
    expect(projects({ thrust: -0.2 })).toEqual(['s']);
  });

  it('yaw + / − maps to d / a (ON-SCREEN right / left)', () => {
    expect(projects({ yaw: 1 })).toEqual(['d']);
    expect(projects({ yaw: -1 })).toEqual(['a']);
  });

  it('pitch + / − maps to f (nose up) / r (nose down)', () => {
    expect(projects({ pitch: 1 })).toEqual(['f']);
    expect(projects({ pitch: -1 })).toEqual(['r']);
  });

  it('roll + / − maps to e / q', () => {
    expect(projects({ roll: 1 })).toEqual(['e']);
    expect(projects({ roll: -1 })).toEqual(['q']);
  });

  it('the boolean channels map to space / Shift', () => {
    expect(projects({ vtol: true })).toEqual([' ']);
    expect(projects({ boost: true })).toEqual(['Shift']);
    expect(projects({ run: true })).toEqual(['Shift']);
    expect(projects({ jump: true })).toEqual([' ']);
  });

  it('starts empty and clear() resets everything', () => {
    const t = new TouchInputSource();
    expect(t.virtualKeys().size).toBe(0);
    t.setChannel({ thrust: 1, boost: true, jump: true });
    expect(t.virtualKeys().size).toBe(3);
    t.clear();
    expect(t.virtualKeys().size).toBe(0);
  });

  it('snapshot() is a copy of the active channels (mutating it is safe)', () => {
    const t = new TouchInputSource();
    t.setChannel({ thrust: 0.5, vtol: true });
    const snap = t.snapshot();
    expect(snap).toEqual({ thrust: 0.5, vtol: true });
    (snap as { thrust?: number }).thrust = 99;
    expect(t.snapshot().thrust).toBe(0.5);
  });

  it('setChannel merges PARTIALLY — absent channels are left as-is', () => {
    const t = new TouchInputSource();
    t.setChannel({ vtol: true, run: true });
    // A joystick update writing only thrust must not drop the buttons.
    t.setChannel({ thrust: 1 });
    expect(t.virtualKeys()).toEqual(keys('w', ' ', 'Shift'));
  });
});

describe('TouchInputSource — combination projection', () => {
  it('projects the union of all active channels (collisions collapse)', () => {
    const t = new TouchInputSource();
    t.setChannel({
      thrust: 1,
      yaw: -1,
      pitch: 1,
      roll: -1,
      vtol: true,
      boost: true,
      jump: true, // vtol + jump both project ' ' — one entry in the set
      run: true, // boost + run both project 'Shift' — one entry
    });
    expect([...t.virtualKeys()].sort()).toEqual([' ', 'Shift', 'a', 'f', 'q', 'w'].sort());
  });
});

describe('flight parity — virtual keys drive readSchemeInput exactly like the physical keys', () => {
  it('space scheme: touch (thrust+yaw+pitch+roll+boost) === keys w,d,f,e,Shift', () => {
    const t = new TouchInputSource();
    t.setChannel({ thrust: 1, yaw: 1, pitch: 1, roll: 1, boost: true });
    expect(readSchemeInput(CONTROL_SCHEMES.space, t.virtualKeys())).toEqual(
      readSchemeInput(CONTROL_SCHEMES.space, keys('w', 'd', 'f', 'e', 'Shift')),
    );
  });

  it('atmosphere scheme: touch vtol === physical space key', () => {
    const t = new TouchInputSource();
    t.setChannel({ thrust: -1, vtol: true });
    expect(readSchemeInput(CONTROL_SCHEMES.atmosphere, t.virtualKeys())).toEqual(
      readSchemeInput(CONTROL_SCHEMES.atmosphere, keys('s', ' ')),
    );
  });
});

describe('on-foot membership — the held virtual keys are the literal keys the loop reads', () => {
  it('walk left + run + jump === w,a,Shift,space membership', () => {
    const t = new TouchInputSource();
    t.setChannel({ thrust: 1, yaw: -1, run: true, jump: true });
    const v = t.virtualKeys();
    for (const key of ['w', 'a', 'Shift', ' ']) expect(v.has(key)).toBe(true);
    // nothing else — in particular no stray 's'/'d'
    expect([...v].sort()).toEqual([' ', 'Shift', 'a', 'w'].sort());
    // and every on-foot key the loop reads is either active or deliberately off
    for (const key of ON_FOOT_KEYS) expect(typeof v.has(key)).toBe('boolean');
  });
});

describe('mergePressed — union of the keyboard and touch sets', () => {
  it('is a true union of both sets', () => {
    const kb = keys('w', 'Shift');
    const t = new TouchInputSource();
    t.setChannel({ yaw: 1, jump: true });
    expect([...mergePressed(kb, t.virtualKeys())].sort()).toEqual([' ', 'Shift', 'w', 'd'].sort());
  });

  it('is a no-op when touch is empty — the keyboard set, unchanged', () => {
    const kb = keys('w', 'd', 'f');
    const merged = mergePressed(kb, new Set<string>());
    expect(merged).toEqual(kb);
  });

  it('returns a FRESH set — mutating the result never touches the inputs', () => {
    const kb = keys('w');
    const merged = mergePressed(kb, keys('e'));
    merged.add('r');
    expect(kb.size).toBe(1);
    expect([...kb][0]).toBe('w');
  });
});
