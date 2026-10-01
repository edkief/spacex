import { describe, expect, it } from 'vitest';

import {
  CONTROL_SCHEMES,
  ControlsRemapper,
  type ControlsLogger,
} from './controls';

const keys = (...list: string[]): Set<string> => new Set(list);

describe('CONTROL_SCHEMES (one key map per regime)', () => {
  it('has a scheme for every regime', () => {
    expect(Object.keys(CONTROL_SCHEMES).sort()).toEqual(['atmosphere', 'space', 'surface']);
  });

  it('space = full flight (thrust/yaw/pitch/roll), no VTOL, no character keys', () => {
    const s = CONTROL_SCHEMES.space;
    expect(s.thrust).not.toBeNull();
    expect(s.yaw).not.toBeNull();
    expect(s.pitch).not.toBeNull();
    expect(s.roll).not.toBeNull();
    expect(s.vtol).toBeNull();
    expect(s.move).toBeNull();
    expect(s.interact).toBeNull();
  });

  it('atmosphere = flight + a vertical VTOL key', () => {
    const a = CONTROL_SCHEMES.atmosphere;
    expect(a.thrust).toEqual(CONTROL_SCHEMES.space.thrust);
    expect(a.vtol).not.toBeNull();
    expect(a.move).toBeNull();
  });

  it('surface = character mode (walk/look/interact) as the TASK-31 stub', () => {
    const s = CONTROL_SCHEMES.surface;
    expect(s.thrust).toBeNull();
    expect(s.vtol).toBeNull();
    expect(s.move).toEqual(
      expect.objectContaining({ forward: expect.any(String), interact: undefined }),
    );
    expect(s.interact).not.toBeNull();
  });
});

describe('ControlsRemapper', () => {
  it('swaps the active scheme instantly on regime change and logs the swap (debug)', () => {
    const logs: Array<Record<string, unknown>> = [];
    const log: ControlsLogger = (_msg, meta) => logs.push(meta ?? {});
    const remapper = new ControlsRemapper('space', log);
    expect(remapper.scheme.regime).toBe('space');

    expect(remapper.setRegime('atmosphere')).toBe(true);
    expect(remapper.scheme.regime).toBe('atmosphere');
    expect(remapper.scheme.vtol).not.toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ from: 'space', to: 'atmosphere' });

    // Repeated set of the same regime: no-op, no duplicate log.
    expect(remapper.setRegime('atmosphere')).toBe(false);
    expect(logs).toHaveLength(1);

    expect(remapper.setRegime('surface')).toBe(true);
    expect(remapper.scheme.move).not.toBeNull();
    expect(logs).toHaveLength(2);
  });

  it('notifies subscribers exactly once per swap', () => {
    const remapper = new ControlsRemapper();
    const seen: string[] = [];
    const off = remapper.subscribe((r) => seen.push(r));
    remapper.setRegime('atmosphere');
    remapper.setRegime('atmosphere');
    remapper.setRegime('space');
    off();
    remapper.setRegime('surface'); // unsubscribed
    expect(seen).toEqual(['atmosphere', 'space']);
  });

  it('readInput maps pressed keys through the ACTIVE scheme (instant remap)', () => {
    const remapper = new ControlsRemapper('space');
    expect(remapper.readInput(keys('w'))).toEqual({ thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0 });
    expect(remapper.readInput(keys('s'))).toMatchObject({ thrust: -1 });
    expect(remapper.readInput(keys('a'))).toMatchObject({ yaw: -1 });
    expect(remapper.readInput(keys('d'))).toMatchObject({ yaw: 1 });
    expect(remapper.readInput(keys('a', 'd'))).toMatchObject({ yaw: 0 });
    // The VTOL key is dead in space.
    expect(remapper.readInput(keys(' ')).up).toBe(0);

    remapper.setRegime('atmosphere');
    expect(remapper.readInput(keys(' ')).up).toBe(1);

    // Surface: flight input is zero (character mode is readCharacterInput).
    remapper.setRegime('surface');
    expect(remapper.readInput(keys('w', ' ', 'a'))).toEqual({
      thrust: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      up: 0,
    });
  });

  it('readCharacterInput reports walk/interact only in the surface scheme', () => {
    const remapper = new ControlsRemapper('space');
    expect(remapper.readCharacterInput(keys('w', 'e'))).toEqual({
      forward: false,
      back: false,
      left: false,
      right: false,
      interact: false,
    });
    remapper.setRegime('surface');
    expect(remapper.readCharacterInput(keys('w', 'e'))).toEqual({
      forward: true,
      back: false,
      left: false,
      right: false,
      interact: true,
    });
    expect(remapper.readCharacterInput(keys('a', 's'))).toMatchObject({ left: true, back: true });
  });
});
