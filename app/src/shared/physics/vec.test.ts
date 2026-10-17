/**
 * Vec3 + Quat math tests. Pure-function tests; no fixtures.
 */

import { describe, expect, it } from "vitest";
import {
  IDENTITY,
  X_AXIS,
  Y_AXIS,
  Z_AXIS,
  ZERO,
  quat,
  quatFromAxisAngle,
  quatFromEuler,
  quatLengthSq,
  quatMul,
  quatNormalize,
  quatRotateVector,
  quatToMat3,
  vec,
  vecAdd,
  vecClamp,
  vecCross,
  vecDot,
  vecEquals,
  vecLength,
  vecLengthSq,
  vecLerp,
  vecMax,
  vecMin,
  vecNormalize,
  vecScale,
  vecSub,
} from "./vec.js";

const EPS_LOOSE = 1e-6;

describe("vec: Vec3 ops", () => {
  it("vec() defaults to zero", () => {
    const v = vec();
    expect(v).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("ZERO / X_AXIS / Y_AXIS / Z_AXIS are frozen unit vectors", () => {
    expect(ZERO).toEqual({ x: 0, y: 0, z: 0 });
    expect(X_AXIS).toEqual({ x: 1, y: 0, z: 0 });
    expect(Y_AXIS).toEqual({ x: 0, y: 1, z: 0 });
    expect(Z_AXIS).toEqual({ x: 0, y: 0, z: 1 });
    // Frozen so callers can't mutate the shared instances.
    expect(Object.isFrozen(ZERO)).toBe(true);
    expect(Object.isFrozen(X_AXIS)).toBe(true);
  });

  it("vecAdd / vecSub / vecScale", () => {
    const a = vec(1, 2, 3);
    const b = vec(4, 5, 6);
    expect(vecAdd(a, b)).toEqual({ x: 5, y: 7, z: 9 });
    expect(vecSub(b, a)).toEqual({ x: 3, y: 3, z: 3 });
    expect(vecScale(a, 2)).toEqual({ x: 2, y: 4, z: 6 });
    expect(vecScale(a, -1)).toEqual({ x: -1, y: -2, z: -3 });
  });

  it("vecDot / vecCross / vecLength / vecLengthSq", () => {
    const a = vec(1, 0, 0);
    const b = vec(0, 1, 0);
    expect(vecDot(a, b)).toBe(0);
    expect(vecDot(a, vec(2, 3, 4))).toBe(2);
    expect(vecCross(a, b)).toEqual({ x: 0, y: 0, z: 1 });
    expect(vecCross(b, a)).toEqual({ x: 0, y: 0, z: -1 });
    expect(vecLength(vec(3, 4, 0))).toBe(5);
    expect(vecLengthSq(vec(3, 4, 0))).toBe(25);
  });

  it("vecNormalize returns unit vector", () => {
    const v = vec(3, 4, 0);
    const n = vecNormalize(v);
    expect(vecLength(n)).toBeCloseTo(1, 12);
    expect(n.x).toBeCloseTo(0.6, 12);
    expect(n.y).toBeCloseTo(0.8, 12);
    expect(n.z).toBeCloseTo(0, 12);
  });

  it("vecNormalize of zero returns zero", () => {
    expect(vecNormalize(ZERO)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("vecLerp at t=0/1 returns endpoints", () => {
    const a = vec(1, 2, 3);
    const b = vec(4, 5, 6);
    expect(vecLerp(a, b, 0)).toEqual(a);
    expect(vecLerp(a, b, 1)).toEqual(b);
    expect(vecLerp(a, b, 0.5)).toEqual({ x: 2.5, y: 3.5, z: 4.5 });
  });

  it("vecEquals with epsilon", () => {
    expect(vecEquals(vec(1, 2, 3), vec(1, 2, 3))).toBe(true);
    expect(vecEquals(vec(1, 2, 3), vec(1 + 1e-12, 2, 3))).toBe(true);
    expect(vecEquals(vec(1, 2, 3), vec(1.001, 2, 3))).toBe(false);
  });

  it("vecMin / vecMax / vecClamp", () => {
    expect(vecMin(vec(1, 5, 3), vec(2, 4, 6))).toEqual({ x: 1, y: 4, z: 3 });
    expect(vecMax(vec(1, 5, 3), vec(2, 4, 6))).toEqual({ x: 2, y: 5, z: 6 });
    expect(vecClamp(vec(-5, 0, 10), -2, 2)).toEqual({ x: -2, y: 0, z: 2 });
  });

  it("vec ops are pure (do not mutate inputs)", () => {
    const a = vec(1, 2, 3);
    const b = vec(4, 5, 6);
    vecAdd(a, b);
    vecScale(a, 7);
    vecNormalize(a);
    expect(a).toEqual({ x: 1, y: 2, z: 3 });
    expect(b).toEqual({ x: 4, y: 5, z: 6 });
  });
});

describe("quat: Quat ops", () => {
  it("IDENTITY is (0,0,0,1) and frozen", () => {
    expect(IDENTITY).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(Object.isFrozen(IDENTITY)).toBe(true);
  });

  it("quat() defaults to identity", () => {
    expect(quat()).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it("quatFromAxisAngle around X by π/2 rotates Y → Z", () => {
    const q = quatFromAxisAngle(X_AXIS, Math.PI / 2);
    const v = quatRotateVector(q, Y_AXIS);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeCloseTo(0, 9);
    expect(v.z).toBeCloseTo(1, 9);
  });

  it("quatFromAxisAngle around Y by π/2 rotates Z → X", () => {
    const q = quatFromAxisAngle(Y_AXIS, Math.PI / 2);
    const v = quatRotateVector(q, Z_AXIS);
    expect(v.x).toBeCloseTo(1, 9);
    expect(v.y).toBeCloseTo(0, 9);
    expect(v.z).toBeCloseTo(0, 9);
  });

  it("quatFromAxisAngle of zero axis returns identity", () => {
    const q = quatFromAxisAngle(ZERO, Math.PI / 4);
    expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it("quatFromEuler: yaw(Y) then pitch(X) then roll(Z)", () => {
    // Pure yaw by π/2: Z → X
    const q1 = quatFromEuler(Math.PI / 2, 0, 0);
    const r1 = quatRotateVector(q1, Z_AXIS);
    expect(r1.x).toBeCloseTo(1, 9);
    expect(r1.y).toBeCloseTo(0, 9);
    expect(r1.z).toBeCloseTo(0, 9);

    // Pure pitch by π/2 around +X: Z → -Y (right-hand rule).
    const q2 = quatFromEuler(0, Math.PI / 2, 0);
    const r2 = quatRotateVector(q2, Z_AXIS);
    expect(r2.x).toBeCloseTo(0, 9);
    expect(r2.y).toBeCloseTo(-1, 9);
    expect(r2.z).toBeCloseTo(0, 9);

    // Pure roll by π/2 around +Z: X → Y (right-hand rule).
    const q3 = quatFromEuler(0, 0, Math.PI / 2);
    const r3 = quatRotateVector(q3, X_AXIS);
    expect(r3.x).toBeCloseTo(0, 9);
    expect(r3.y).toBeCloseTo(1, 9);
    expect(r3.z).toBeCloseTo(0, 9);
  });

  it("quatMul is associative for sanity", () => {
    const q1 = quatFromAxisAngle(X_AXIS, 0.3);
    const q2 = quatFromAxisAngle(Y_AXIS, 0.7);
    const q3 = quatFromAxisAngle(Z_AXIS, -0.4);
    const ab_c = quatMul(quatMul(q1, q2), q3);
    const a_bc = quatMul(q1, quatMul(q2, q3));
    // Not strictly associative in general (because of the conjugate on
    // the right), but the *rotation* effect should be.
    const v = vec(1, 2, 3);
    const e1 = quatRotateVector(ab_c, v);
    const e2 = quatRotateVector(a_bc, v);
    expect(vecEquals(e1, e2, 1e-6)).toBe(true);
  });

  it("quatNormalize handles drift", () => {
    const q = quatFromAxisAngle(X_AXIS, 0.4);
    // Compose many times to accumulate drift.
    let acc = IDENTITY;
    for (let i = 0; i < 100; i++) acc = quatMul(acc, q);
    const norm = quatNormalize(acc);
    expect(Math.abs(quatLengthSq(norm) - 1)).toBeLessThan(EPS_LOOSE);
  });

  it("quatRotateVector of identity is identity", () => {
    const v = vec(3, 4, 5);
    expect(quatRotateVector(IDENTITY, v)).toEqual(v);
  });

  it("quatToMat3 produces orthonormal rows", () => {
    const q = quatFromEuler(0.3, 0.5, -0.2);
    const m = quatToMat3(q);
    expect(m.length).toBe(9);
    // Row 0:
    const r0 = [m[0]!, m[1]!, m[2]!];
    const r1 = [m[3]!, m[4]!, m[5]!];
    const r2 = [m[6]!, m[7]!, m[8]!];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(r0, r1)).toBeCloseTo(0, 6);
    expect(dot(r1, r2)).toBeCloseTo(0, 6);
    expect(dot(r0, r2)).toBeCloseTo(0, 6);
    expect(Math.sqrt(dot(r0, r0))).toBeCloseTo(1, 6);
    expect(Math.sqrt(dot(r1, r1))).toBeCloseTo(1, 6);
    expect(Math.sqrt(dot(r2, r2))).toBeCloseTo(1, 6);
  });

  it("round trip: rotate then inverse-rotate returns the input", () => {
    const q = quatFromAxisAngle(Y_AXIS, 0.7);
    // inverse of unit quaternion = conjugate
    const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const v = vec(1, 2, 3);
    const rotated = quatRotateVector(q, v);
    const back = quatRotateVector(inv, rotated);
    expect(back.x).toBeCloseTo(v.x, 9);
    expect(back.y).toBeCloseTo(v.y, 9);
    expect(back.z).toBeCloseTo(v.z, 9);
  });
});
