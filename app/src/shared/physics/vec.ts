/**
 * Plain-object vector and quaternion math for the flight model.
 *
 * Everything in here is deliberately dependency-free: no classes, no
 * THREE.Vector3, no gl-matrix. The flight model runs on the server
 * (Node) and the client (browser) and must produce identical results
 * to the bit — depending on a third-party math library would tie the
 * simulation to whichever shape that library exposes (`Float32Array`
 * vs plain object, mutable vs immutable, etc.). Plain objects also
 * round-trip through `JSON.stringify` for golden fixtures.
 *
 * Conventions:
 *   - Right-handed coordinate system, +Y up.
 *   - Rotations are intrinsic; `quatFromEuler(yaw, pitch, roll)` applies
 *     yaw (Y axis), then pitch (X axis), then roll (Z axis) — i.e.
 *     `q = q_yaw * q_pitch * q_roll`.
 *   - `quatRotateVector(q, v)` returns the world-space vector after
 *     rotating `v` by `q`.
 *
 * Pure functions, no mutation. Callers that want to integrate over
 * thousands of ticks per server frame allocate freely — the GC cost is
 * negligible compared to the noise/render work elsewhere.
 */

// ---------------------------------------------------------------------------
// Vec3
// ---------------------------------------------------------------------------

/** A 3-D vector with x/y/z in arbitrary sim units (1 u ≈ 1 m). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The origin. */
export const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

/** The world +X axis. */
export const X_AXIS: Readonly<Vec3> = Object.freeze({ x: 1, y: 0, z: 0 });
/** The world +Y axis (up). */
export const Y_AXIS: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });
/** The world +Z axis. */
export const Z_AXIS: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 1 });

/** Allocate a fresh `Vec3`. */
export function vec(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

/** `a + b`. */
export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/** `a - b`. */
export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** `a * s` (scalar). */
export function vecScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/** Dot product `a · b`. */
export function vecDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Cross product `a × b`. */
export function vecCross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Squared length `|a|²`. Cheaper than `vecLength` when only the relative size matters. */
export function vecLengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

/** Length `|a|`. */
export function vecLength(a: Vec3): number {
  return Math.sqrt(vecLengthSq(a));
}

/**
 * Returns a unit-length copy of `a`. If `a` is (numerically) zero, the
 * returned vector is also zero — the caller is responsible for clamping
 * the input velocity to a non-zero floor before normalising.
 */
export function vecNormalize(a: Vec3): Vec3 {
  const len = vecLength(a);
  if (len < 1e-12) return { x: 0, y: 0, z: 0 };
  const inv = 1 / len;
  return { x: a.x * inv, y: a.y * inv, z: a.z * inv };
}

/** Linear interpolation `a + (b - a) * t`. */
export function vecLerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** Component-wise equality within `epsilon`. */
export function vecEquals(a: Vec3, b: Vec3, epsilon = 1e-9): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon && Math.abs(a.z - b.z) < epsilon
  );
}

/** Component-wise min. */
export function vecMin(a: Vec3, b: Vec3): Vec3 {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
}

/** Component-wise max. */
export function vecMax(a: Vec3, b: Vec3): Vec3 {
  return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
}

/** Clamp `a` so every component lies in `[lo, hi]`. */
export function vecClamp(a: Vec3, lo: number, hi: number): Vec3 {
  return {
    x: Math.min(Math.max(a.x, lo), hi),
    y: Math.min(Math.max(a.y, lo), hi),
    z: Math.min(Math.max(a.z, lo), hi),
  };
}

// ---------------------------------------------------------------------------
// Quat
// ---------------------------------------------------------------------------

/**
 * A unit quaternion `(x, y, z, w)`.
 *
 * We always pass unit quaternions around; `quatMul` does NOT
 * automatically renormalise. Callers that compose many small rotations
 * in a row (e.g. the space regime turn integration) should renormalise
 * every few steps to avoid float drift accumulating magnitude above 1.
 */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** The identity rotation. */
export const IDENTITY: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

/** Allocate a fresh `Quat` (defaults to identity). */
export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w };
}

/** Quaternion from an axis-angle pair (axis does NOT need to be unit length; the result is normalised). */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const half = angle * 0.5;
  const s = Math.sin(half);
  const n = vecLength(axis);
  if (n < 1e-12) return { x: 0, y: 0, z: 0, w: 1 };
  const k = s / n;
  return {
    x: axis.x * k,
    y: axis.y * k,
    z: axis.z * k,
    w: Math.cos(half),
  };
}

/**
 * Build a quaternion from Euler angles.
 *
 * Convention: yaw around world +Y, then pitch around the resulting +X,
 * then roll around the resulting +Z. This matches the natural flight
 * model "rudder pedals → pitch the nose up/down, stick left/right →
 * roll, twist the stick → yaw" without an extra matrix decomposition.
 *
 * The expression below is the closed-form expansion of
 * `quatMul(quatFromAxisAngle(Y_AXIS, yaw), quatMul(quatFromAxisAngle(X_AXIS, pitch), quatFromAxisAngle(Z_AXIS, roll)))`.
 */
export function quatFromEuler(yaw: number, pitch: number, roll: number): Quat {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  return quatNormalize({
    x: cy * sp * cr + sy * cp * sr,
    y: sy * cp * cr,
    z: cp * cy * sr - sp * sy * cr,
    w: cp * cy * cr,
  });
}

/** Hamilton product `a * b` (i.e. apply `b` first then `a`). */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Normalise `q` to unit length. Returns identity if `q` is (numerically) zero. */
export function quatNormalize(q: Quat): Quat {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len < 1e-12) return { x: 0, y: 0, z: 0, w: 1 };
  const inv = 1 / len;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
}

/**
 * Rotate a vector by a quaternion. Uses the optimised formula
 * `v' = v + 2 * q_w * (q_v × v) + 2 * (q_v × (q_v × v))` which avoids
 * the cost of constructing two quaternion-vectors and multiplying them.
 */
export function quatRotateVector(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Squared magnitude of the quaternion `(x, y, z, w)`. */
export function quatLengthSq(q: Quat): number {
  return q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
}

/** Magnitude. */
export function quatLength(q: Quat): number {
  return Math.sqrt(quatLengthSq(q));
}

/**
 * Convert a quaternion to a 3×3 rotation matrix (row-major flat
 * array of 9 numbers). The renderer can pass this straight to a
 * THREE.Matrix3 or `gl.uniformMatrix3fv` site without an import.
 */
export function quatToMat3(q: Quat): readonly number[] {
  const { x, y, z, w } = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    1 - 2 * (yy + zz),
    2 * (xy + wz),
    2 * (xz - wy),
    2 * (xy - wz),
    1 - 2 * (xx + zz),
    2 * (yz + wx),
    2 * (xz + wy),
    2 * (yz - wx),
    1 - 2 * (xx + yy),
  ];
}
