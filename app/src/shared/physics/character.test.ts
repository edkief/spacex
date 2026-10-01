import { describe, expect, it } from 'vitest';

import { characterSpawnPos, CHAR_SHIP_SIDE_OFFSET_M } from './character';
import { quatFromEuler, quatIdentity, type Vec3 } from './vec';

/**
 * TASK-31: disembark spawn math — 2.5 m perpendicular to the ship's forward,
 * pinned to the pad plane. Pure: no DOM, no clock, no Math.random.
 */

const SHIP_POS: Vec3 = { x: 100, y: 7.5, z: -40 };

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('characterSpawnPos (TASK-31)', () => {
  it('identity quaternion: spawns 2.5 m along world +X, y pinned to the pad height', () => {
    // Ship resting AT the pad height: the spawn is a pure lateral shift.
    const pos = characterSpawnPos({ ...SHIP_POS, y: 5 }, quatIdentity(), 5);
    expect(pos.x).toBeCloseTo(SHIP_POS.x + CHAR_SHIP_SIDE_OFFSET_M, 6);
    expect(pos.y).toBe(5);
    expect(pos.z).toBeCloseTo(SHIP_POS.z, 6);
    expect(distance(pos, { ...SHIP_POS, y: 5 })).toBeCloseTo(CHAR_SHIP_SIDE_OFFSET_M, 6);
  });

  it('yawed ship: the offset rotates with the ship (perpendicular to forward)', () => {
    // 90° yaw (rotation about +Y): forward (+Z) turns to +X and the ship's
    // right axis (+X) turns to -Z — the spawn must sit EXACTLY perpendicular
    // to the new forward.
    const quat = quatFromEuler(Math.PI / 2, 0, 0);
    const atPad: Vec3 = { ...SHIP_POS, y: 0 };
    const pos = characterSpawnPos(atPad, quat, 0);
    expect(distance(pos, atPad)).toBeCloseTo(CHAR_SHIP_SIDE_OFFSET_M, 6);
    const dx = pos.x - atPad.x;
    const dz = pos.z - atPad.z;
    expect(dx).toBeCloseTo(0, 6); // no forward component (forward is now +X)
    expect(dz).toBeCloseTo(-CHAR_SHIP_SIDE_OFFSET_M, 6);
  });

  it('always lands on the pad plane (y = pad height) regardless of ship altitude', () => {
    const high = { ...SHIP_POS, y: 120 };
    const pos = characterSpawnPos(high, quatIdentity(), 3.25);
    expect(pos.y).toBe(3.25);
  });
});
