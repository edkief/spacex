import { describe, expect, it } from 'vitest';

import { playCombatFx, type CombatEvent, type FxWorld } from './fx';

/**
 * TASK-48.3: the drone's shot reads through the STANDARD combat events —
 * the server's droneFire broadcasts a plain 'hit' with source {kind:'drone'}
 * (no new event type), and the FX dispatcher surfaces it exactly like any
 * other landed hit: an impact flash at the resolved target position.
 */

interface Calls {
  world: FxWorld;
  laser: Array<[unknown, unknown]>;
  impact: Array<unknown>;
  explosion: Array<unknown>;
  shake: Array<number>;
}

function fxSpy(): Calls {
  const laser: Array<[unknown, unknown]> = [];
  const impact: Array<unknown> = [];
  const explosion: Array<unknown> = [];
  const shake: Array<number> = [];
  return {
    world: {
      addLaserFlash: (from, to) => {
        laser.push([from, to]);
      },
      addImpactFlash: (point) => {
        impact.push(point);
      },
      addExplosion: (point) => {
        explosion.push(point);
      },
      screenShake: (px) => {
        shake.push(px);
      },
    },
    laser,
    impact,
    explosion,
    shake,
  };
}

const DRONE_HIT: CombatEvent = {
  kind: 'hit',
  target: 'char:p1',
  source: { kind: 'drone', id: 'drone:sys0:hz:2:0' },
  weapon: 'drone-cannon',
  damage: 3,
  shieldHit: 3,
  hullHit: 0,
};

describe('playCombatFx — destruction (TASK-49)', () => {
  const DESTROYED: CombatEvent = {
    kind: 'destroyed',
    target: 'ship-p2',
    source: { kind: 'player', id: 'p1' },
    weapon: 'laser',
  };

  it("a 'destroyed' event at a known target plays the EXPLOSION (not a small impact flash) + a 6 px shake", () => {
    const { world, explosion, impact, shake } = fxSpy();
    playCombatFx(world, DESTROYED, (id) => (id === 'ship-p2' ? { x: 5, y: 6, z: 7 } : null));
    expect(explosion).toEqual([{ x: 5, y: 6, z: 7 }]);
    // The explosion supersedes the small impact flash for a destruction.
    expect(impact).toEqual([]);
    expect(shake).toEqual([6]);
  });

  it("a 'destroyed' at an UNRESOLVABLE target produces no FX (same rule as every other event)", () => {
    const { world, explosion, shake } = fxSpy();
    playCombatFx(world, DESTROYED, () => null);
    expect(explosion).toEqual([]);
    expect(shake).toEqual([]);
  });
});

describe('playCombatFx — drone shots (TASK-48.3)', () => {
  it("a drone 'hit' on the player surfaces an impact flash at the target (the standard event path)", () => {
    const { world, impact, laser, shake } = fxSpy();
    playCombatFx(world, DRONE_HIT, (id) => (id === 'char:p1' ? { x: 10, y: 2, z: -30 } : null));
    expect(impact).toEqual([{ x: 10, y: 2, z: -30 }]);
    // Nothing else fires for a drone hit (no laser line, no shake).
    expect(laser).toEqual([]);
    expect(shake).toEqual([]);
  });

  it('a drone hit at an UNRESOLVABLE target produces no FX (same rule as every other hit)', () => {
    const { world, impact } = fxSpy();
    playCombatFx(world, DRONE_HIT, () => null);
    expect(impact).toEqual([]);
  });

  it('a player laser keeps using the standard laser-fired flash (the drone source does not leak into it)', () => {
    const { world, laser, impact } = fxSpy();
    const laserFired: CombatEvent = {
      kind: 'laser-fired',
      source: { kind: 'player', id: 'p1' },
      weapon: 'scout-laser',
      from: { x: 0, y: 0, z: 0 },
      to: { x: 100, y: 0, z: 0 },
    };
    playCombatFx(world, laserFired, () => null);
    expect(laser).toEqual([
      [
        { x: 0, y: 0, z: 0 },
        { x: 100, y: 0, z: 0 },
      ],
    ]);
    expect(impact).toEqual([]);
  });
});
