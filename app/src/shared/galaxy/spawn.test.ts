import { describe, expect, it } from 'vitest';

import { SPAWN_GATE_DISTANCE_U, SPAWN_GATE_POS, SPAWN_GATE_QUAT, spawnGatePose } from './spawn';
import { quatRotateVector } from '../physics/vec';

/**
 * TASK-8 spawn gate: the deterministic arrival pose for a warping ship —
 * 100 u from the star along +X, facing the star (forward +Z → −X).
 */

describe('spawn gate (TASK-8)', () => {
  it('sits SPAWN_GATE_DISTANCE_U (100 u) from the star along +X', () => {
    expect(SPAWN_GATE_DISTANCE_U).toBe(100);
    expect(SPAWN_GATE_POS).toEqual({ x: 100, y: 0, z: 0 });
  });

  it('orients the ship forward (+Z) onto −X (facing the star at the origin)', () => {
    const forward = quatRotateVector(SPAWN_GATE_QUAT, { x: 0, y: 0, z: 1 });
    expect(Math.abs(forward.x + 1)).toBeLessThan(1e-9);
    expect(Math.abs(forward.y)).toBeLessThan(1e-9);
    expect(Math.abs(forward.z)).toBeLessThan(1e-9);
  });

  it('is a pure yaw: the up axis is unchanged', () => {
    const up = quatRotateVector(SPAWN_GATE_QUAT, { x: 0, y: 1, z: 0 });
    expect(Math.abs(up.x)).toBeLessThan(1e-9);
    expect(Math.abs(up.y - 1)).toBeLessThan(1e-9);
    expect(Math.abs(up.z)).toBeLessThan(1e-9);
  });

  it('spawnGatePose returns copies (mutating a pose never touches the constants)', () => {
    const pose = spawnGatePose();
    expect(pose.pos).toEqual(SPAWN_GATE_POS);
    expect(pose.quat).toEqual(SPAWN_GATE_QUAT);
    pose.pos.x = 0;
    pose.quat.x = 1;
    expect(SPAWN_GATE_POS.x).toBe(100);
    expect(SPAWN_GATE_QUAT.x).toBe(0);
  });
});
