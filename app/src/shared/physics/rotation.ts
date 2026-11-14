import { fromAxisAngle, multiply, normalizeQuat, type Quat, type Vec3 } from './vec.ts';

/** Ship-local axes: nose is -z, up is +y, right is +x. */
export const FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
export const UP: Vec3 = { x: 0, y: 1, z: 0 };

export interface RotationInput {
  yaw: number;
  pitch: number;
  roll: number;
}

/**
 * Turns the ship at up to `turnRate` rad/s about its own axes (+yaw = left, +pitch = nose up,
 * +roll = bank right). The three demands are combined and capped to magnitude 1, so the total
 * angular speed never exceeds the class turn rate. No angular inertia.
 */
export function rotate(q: Quat, input: RotationInput, turnRate: number, dt: number): Quat {
  let wx = input.pitch;
  let wy = input.yaw;
  let wz = -input.roll; // banking right is a rotation about the nose (-z) axis
  const magnitude = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (magnitude === 0) return q;
  if (magnitude > 1) {
    wx /= magnitude;
    wy /= magnitude;
    wz /= magnitude;
  }
  const rate = Math.min(1, magnitude) * turnRate;
  const axis = {
    x: wx / Math.min(1, magnitude),
    y: wy / Math.min(1, magnitude),
    z: wz / Math.min(1, magnitude),
  };
  return normalizeQuat(multiply(q, fromAxisAngle(axis, rate * dt)));
}
