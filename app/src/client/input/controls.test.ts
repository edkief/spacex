import { describe, expect, it } from 'vitest';

import { integrateShip, restShipState } from '@shared/physics/flight';
import { shipStats } from '@shared/ships';
import { quatRotateVector, type Quat, type Vec3 } from '@shared/physics/vec';

import { CONTROL_SCHEMES, ControlsRemapper, type ControlsLogger } from './controls';

const keys = (...list: string[]): Set<string> => new Set(list);

/** The frame cheat sheet (TASK-80): right-handed, +Y up, +Z forward ⇒ right = −X. */
const FORWARD: Vec3 = { x: 0, y: 0, z: 1 };
const UP: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * Drive ONE held key through the real flight physics for `secs` (20 Hz,
 * scout class, from the identity quat) and return the final quat — the
 * key's on-screen effect is read off that quat.
 */
function steer(key: string, secs: number, regime: 'space' | 'atmosphere' = 'space'): Quat {
  const remapper = new ControlsRemapper(regime);
  const input = remapper.readInput(new Set([key]));
  let s = restShipState({ x: 0, y: 100, z: 0 }, regime);
  const dt = 0.05;
  for (let i = 0; i < Math.round(secs / dt); i++) {
    s = integrateShip(
      s,
      input,
      dt,
      regime,
      { atmosphereDensity: 0, atmosphereRadius: 5000 },
      shipStats('scout'),
    );
  }
  return s.quat;
}

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
    expect(s.move).toEqual({
      forward: expect.any(String),
      back: expect.any(String),
      left: expect.any(String),
      right: expect.any(String),
    });
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
    // TASK-80 sign translation: the on-screen [right, left] pair arrives in
    // the physics convention, where +yaw = nose toward local +X (screen
    // LEFT) — so D (turn right) reads −1 and A (turn left) reads +1.
    expect(remapper.readInput(keys('a'))).toMatchObject({ yaw: 1 });
    expect(remapper.readInput(keys('d'))).toMatchObject({ yaw: -1 });
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

describe('keys → on-screen direction (TASK-80: D must turn RIGHT)', () => {
  // Frame: right-handed, +Y up, +Z forward ⇒ the ship's RIGHT is local −X
  // (the chase camera looks along the ship's +Z, so screen-right = −X).

  it('space: D yaws the nose toward local -X (screen-right, forward x < 0); A toward +X', () => {
    const fwdD = quatRotateVector(steer('d', 0.5), FORWARD);
    const fwdA = quatRotateVector(steer('a', 0.5), FORWARD);
    expect(fwdD.x).toBeLessThan(0); // D turns toward local −X = screen-right
    expect(fwdA.x).toBeGreaterThan(0); // A turns toward local +X = screen-left
  });

  it('space: Q rolls LEFT (the up vector tilts toward +X = screen-left); E rolls right', () => {
    const upQ = quatRotateVector(steer('q', 0.5), UP);
    const upE = quatRotateVector(steer('e', 0.5), UP);
    expect(upQ.x).toBeGreaterThan(0); // top tilts left
    expect(upE.x).toBeLessThan(0); // top tilts right
  });

  it('space: pitch is NOT mirrored — R noses down, F noses up (unchanged)', () => {
    const fwdR = quatRotateVector(steer('r', 0.5), FORWARD);
    const fwdF = quatRotateVector(steer('f', 0.5), FORWARD);
    expect(fwdR.y).toBeLessThan(0);
    expect(fwdF.y).toBeGreaterThan(0);
  });

  it('atmosphere scheme: the same keys produce the same on-screen directions', () => {
    const fwdD = quatRotateVector(steer('d', 0.5, 'atmosphere'), FORWARD);
    const fwdA = quatRotateVector(steer('a', 0.5, 'atmosphere'), FORWARD);
    expect(fwdD.x).toBeLessThan(0);
    expect(fwdA.x).toBeGreaterThan(0);
  });
});
