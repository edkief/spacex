import { describe, expect, it } from 'vitest';
import {
  quat,
  quatAngleBetween,
  quatFromAxisAngle,
  quatSlerp,
  quatFromEuler,
  quatIdentity,
  quatLength,
  quatMultiply,
  quatNormalize,
  quatRotateVector,
  quatToMat3,
  vec,
  vecAdd,
  vecCross,
  vecDot,
  vecLength,
  vecLerp,
  vecNormalize,
  vecScale,
  vecSub,
} from './vec';

const HALF_PI = Math.PI / 2;

describe('vec3 ops', () => {
  it('add/sub/scale', () => {
    expect(vecAdd(vec(1, 2, 3), vec(4, 5, 6))).toEqual(vec(5, 7, 9));
    expect(vecSub(vec(1, 2, 3), vec(4, 5, 6))).toEqual(vec(-3, -3, -3));
    expect(vecScale(vec(1, -2, 3), 2)).toEqual(vec(2, -4, 6));
  });

  it('dot and cross', () => {
    expect(vecDot(vec(1, 2, 3), vec(4, 5, 6))).toBe(32);
    expect(vecCross(vec(1, 0, 0), vec(0, 1, 0))).toEqual(vec(0, 0, 1));
    expect(vecCross(vec(0, 1, 0), vec(0, 0, 1))).toEqual(vec(1, 0, 0));
    expect(vecCross(vec(0, 0, 1), vec(1, 0, 0))).toEqual(vec(0, 1, 0));
  });

  it('length and normalize', () => {
    expect(vecLength(vec(3, 4, 0))).toBe(5);
    expect(vecNormalize(vec(0, 10, 0))).toEqual(vec(0, 1, 0));
    // near-zero input never divides by zero
    expect(vecNormalize(vec(0, 0, 0))).toEqual(vec(0, 0, 0));
  });

  it('lerp interpolates linearly', () => {
    expect(vecLerp(vec(0, 0, 0), vec(10, -4, 2), 0.5)).toEqual(vec(5, -2, 1));
    expect(vecLerp(vec(1, 1, 1), vec(2, 2, 2), 0)).toEqual(vec(1, 1, 1));
    expect(vecLerp(vec(1, 1, 1), vec(2, 2, 2), 1)).toEqual(vec(2, 2, 2));
  });
});

describe('quaternions', () => {
  it('identity is a no-op rotation', () => {
    const q = quatIdentity();
    expect(quatLength(q)).toBe(1);
    expect(quatRotateVector(q, vec(1, 2, 3))).toEqual(vec(1, 2, 3));
  });

  it('fromEuler(0,0,0) is identity', () => {
    expect(quatFromEuler(0, 0, 0)).toEqual(quatIdentity());
  });

  it('yaw +90° rotates forward (+Z) to +X', () => {
    const f = quatRotateVector(quatFromEuler(HALF_PI, 0, 0), vec(0, 0, 1));
    expect(f.x).toBeCloseTo(1, 12);
    expect(f.y).toBeCloseTo(0, 12);
    expect(f.z).toBeCloseTo(0, 12);
  });

  it('pitch +90° rotates forward (+Z) to -Y (nose down)', () => {
    const f = quatRotateVector(quatFromEuler(0, HALF_PI, 0), vec(0, 0, 1));
    expect(f).toEqual({
      x: expect.closeTo(0, 12),
      y: expect.closeTo(-1, 12),
      z: expect.closeTo(0, 12),
    });
  });

  it('roll +90° rotates +X to +Y', () => {
    const f = quatRotateVector(quatFromEuler(0, 0, HALF_PI), vec(1, 0, 0));
    expect(f.x).toBeCloseTo(0, 12);
    expect(f.y).toBeCloseTo(1, 12);
    expect(f.z).toBeCloseTo(0, 12);
  });

  it('multiply composes rotations in order (b first, then a)', () => {
    const a = quatFromAxisAngle(vec(0, 1, 0), 0.3);
    const b = quatFromAxisAngle(vec(1, 0, 0), 0.7);
    const v = vec(0.4, 0.9, 0.1);
    const composed = quatRotateVector(quatMultiply(a, b), v);
    const sequential = quatRotateVector(a, quatRotateVector(b, v));
    expect(composed.x).toBeCloseTo(sequential.x, 12);
    expect(composed.y).toBeCloseTo(sequential.y, 12);
    expect(composed.z).toBeCloseTo(sequential.z, 12);
  });

  it('multiply preserves unit length (normalize cleans drift)', () => {
    const a = quatFromEuler(0.3, 0.4, 0.5);
    const b = quatFromEuler(1.1, -0.2, 0.9);
    const p = quatMultiply(quatMultiply(a, b), a);
    const n = quatNormalize(p);
    expect(quatLength(n)).toBeCloseTo(1, 12);
    // normalization of an already-normal quat is a no-op
    const id = quatNormalize(quatIdentity());
    expect(id).toEqual(quatIdentity());
  });

  it('toMat3 matches rotateVector and is orthonormal', () => {
    const q = quatNormalize(quatFromEuler(0.7, -0.4, 1.1));
    const m = quatToMat3(q);
    const v = vec(0.2, -0.5, 0.9);
    const mv = vec(
      m[0] * v.x + m[1] * v.y + m[2] * v.z,
      m[3] * v.x + m[4] * v.y + m[5] * v.z,
      m[6] * v.x + m[7] * v.y + m[8] * v.z,
    );
    const qv = quatRotateVector(q, v);
    expect(mv.x).toBeCloseTo(qv.x, 12);
    expect(mv.y).toBeCloseTo(qv.y, 12);
    expect(mv.z).toBeCloseTo(qv.z, 12);

    // rows are orthonormal
    const rows = [m.slice(0, 3), m.slice(3, 6), m.slice(6, 9)];
    for (let i = 0; i < 3; i++) {
      expect(rows[i][0] ** 2 + rows[i][1] ** 2 + rows[i][2] ** 2).toBeCloseTo(1, 12);
      for (let j = 0; j < 3; j++) {
        if (i !== j) {
          expect(
            rows[i][0] * rows[j][0] + rows[i][1] * rows[j][1] + rows[i][2] * rows[j][2],
          ).toBeCloseTo(0, 12);
        }
      }
    }
  });

  it('is deterministic: identical inputs give bit-identical outputs', () => {
    const q = quatFromEuler(0.123, -0.456, 0.789);
    const a = quatRotateVector(q, vec(1, 2, 3));
    const b = quatRotateVector(quatFromEuler(0.123, -0.456, 0.789), vec(1, 2, 3));
    expect(a).toStrictEqual(b);
    const p = quatMultiply(quat(0.1, 0.2, 0.3, 0.9), q);
    expect(p).toStrictEqual(quatMultiply(quat(0.1, 0.2, 0.3, 0.9), q));
  });

  it('repeated small rotations drift without re-normalization (guard for sim loop)', () => {
    let q = quatIdentity();
    const step = quatFromEuler(0.02, 0, 0);
    for (let i = 0; i < 1000; i++) q = quatMultiply(q, step);
    // raw product drifts slightly from unit length over long ticks, and
    // quatNormalize (what the sim applies each tick) restores it
    expect(Math.abs(quatLength(q) - 1)).toBeLessThan(1e-9);
    expect(quatLength(quatNormalize(q))).toBeCloseTo(1, 12);
  });
});

describe('quatSlerp / quatAngleBetween (TASK-14 interpolation + reconciliation)', () => {
  const yaw = (a: number) => quatFromAxisAngle({ x: 0, y: 1, z: 0 }, a);

  it('slerp endpoints and midpoint are exact on the arc', () => {
    const a = yaw(0);
    const b = yaw(1);
    expect(quatSlerp(a, b, 0)).toEqual(a);
    expect(quatSlerp(a, b, 1)).toEqual(b);
    const mid = quatSlerp(a, b, 0.5);
    expect(quatAngleBetween(mid, yaw(0.5))).toBeLessThan(1e-12); // exact arc midpoint
  });

  it('slerp takes the short arc (flips antipodal inputs)', () => {
    const a = quat(0, 0, 0, 1);
    const b = quat(0, -0.70710678, 0, -0.70710678); // antipodal to yaw(π/2)
    const mid = quatSlerp(a, b, 0.5);
    // Short arc: π/4 rotation, not 3π/4.
    expect(quatAngleBetween(mid, yaw(Math.PI / 4))).toBeLessThan(1e-9);
  });

  it('slerp is exact for constant angular velocity (render-capture basis)', () => {
    // A ship yawing at 0.5 rad/s between two 100 ms samples: slerp at f must
    // sit exactly on the arc — no wobble for the interpolation test.
    const a = yaw(0);
    const b = yaw(0.05);
    for (const f of [0.1, 0.37, 0.72, 0.99]) {
      expect(quatAngleBetween(quatSlerp(a, b, f), yaw(0.05 * f))).toBeLessThan(1e-12);
    }
  });

  it('slerp handles near-parallel quaternions without degeneracy', () => {
    const a = yaw(0.1);
    const b = yaw(0.10001);
    const mid = quatSlerp(a, b, 0.5);
    expect(quatLength(mid)).toBeCloseTo(1, 12);
    expect(quatAngleBetween(mid, yaw(0.100005))).toBeLessThan(1e-6);
  });

  it('quatAngleBetween: identity 0, opposite π, antipodal 0', () => {
    expect(quatAngleBetween(quatIdentity(), quatIdentity())).toBeCloseTo(0, 12);
    expect(quatAngleBetween(quatIdentity(), yaw(Math.PI))).toBeCloseTo(Math.PI, 12);
    expect(quatAngleBetween(yaw(0.3), yaw(0.8))).toBeCloseTo(0.5, 12);
    const q = yaw(0.3);
    expect(quatAngleBetween(q, { x: -q.x, y: -q.y, z: -q.z, w: -q.w })).toBeLessThan(1e-7); // antipodal quats are the same rotation (fp roundoff)
  });

  it('repeated slerp steps do not accumulate drift (interpolation is idempotent)', () => {
    const a = yaw(0);
    const b = yaw(0.9);
    let q = a;
    for (let i = 0; i < 20; i++) q = quatSlerp(q, b, 0.5);
    expect(quatAngleBetween(q, b)).toBeLessThan(1e-6);
    expect(quatLength(q)).toBeCloseTo(1, 12);
  });
});
