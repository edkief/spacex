/**
 * Minimal 3D vector + quaternion math for the shared flight model (TASK-22).
 *
 * Plain objects + pure functions, no dependencies, fully deterministic
 * (only +, -, *, / — never Math.random). The server sim and the client
 * prediction must both use these exact implementations so their state
 * streams stay bit-identical.
 *
 * Units: 1 u ≈ 1 m, velocities in u/s, angles in radians.
 *
 * Conventions:
 * - Right-handed coordinates: +X right, +Y up, +Z forward (ship forward is +Z).
 * - Quaternions are Hamilton, stored {x, y, z, w} (scalar last), unit length.
 * - fromEuler(yaw, pitch, roll) applies yaw around Y, then pitch around X,
 *   then roll around Z (intrinsic-style, standard aerospace order):
 *   q = qYaw * qPitch * qRoll.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Hamilton quaternion, scalar component last. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function quat(x: number, y: number, z: number, w: number): Quat {
  return { x, y, z, w };
}

/** Identity quaternion. */
export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vecScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function vecDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vecCross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vecLength(a: Vec3): number {
  return Math.sqrt(vecDot(a, a));
}

/** Normalize; a zero (or near-zero) vector returns {0, 0, 0}. */
export function vecNormalize(a: Vec3): Vec3 {
  const len = vecLength(a);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  const inv = 1 / len;
  return { x: a.x * inv, y: a.y * inv, z: a.z * inv };
}

/** Linear interpolation between two vectors, t in [0, 1]. */
export function vecLerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** Quaternion from a rotation of `angle` radians around a unit axis. */
export function quatFromAxisAngle(ax: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: Math.cos(angle / 2) };
}

/**
 * Quaternion from Euler angles in radians (yaw around +Y, pitch around +X,
 * roll around +Z), in the order q = qYaw * qPitch * qRoll.
 */
export function quatFromEuler(yaw: number, pitch: number, roll: number): Quat {
  const qy = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw);
  const qx = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitch);
  const qz = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, roll);
  return quatMultiply(quatMultiply(qy, qx), qz);
}

/** Hamilton product a * b (apply b first, then a, to a vector). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatLength(a: Quat): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w);
}

export function quatNormalize(a: Quat): Quat {
  const len = quatLength(a);
  if (len === 0) return quatIdentity();
  const inv = 1 / len;
  return { x: a.x * inv, y: a.y * inv, z: a.z * inv, w: a.w * inv };
}

/**
 * Inverse quaternion (conjugate normalized — exact for unit quats, safe for
 * near-unit ones). q⁻¹ undoes q: quatMultiply(q, quatInverse(q)) ≈ identity.
 */
export function quatInverse(a: Quat): Quat {
  const len2 = a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w;
  if (len2 === 0) return quatIdentity();
  const inv = 1 / len2;
  return { x: -a.x * inv, y: -a.y * inv, z: -a.z * inv, w: a.w * inv };
}

/**
 * Rotation matrix for q as a row-major number[9].
 * Row i starts at index 3*i.
 */
export function quatToMat3(q: Quat): number[] {
  const { x, y, z, w } = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

/** Smallest rotation (radians, 0..π) between two quaternions. */
export function quatAngleBetween(a: Quat, b: Quat): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, Math.max(0, dot)));
}

/**
 * Spherical linear interpolation between quaternions, t in [0, 1].
 * Takes the short arc (flips b when the dot is negative). The sin ratio
 * stays numerically stable for arbitrarily small arcs (both terms scale
 * linearly with the angle), so the ONLY degenerate case is the identical
 * (or flipped-antipodal) rotation where sin(θ) = 0: return a as-is.
 * Deterministic (only +, -, *, /, acos, sin).
 */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const bb: Quat = dot < 0 ? { x: -b.x, y: -b.y, z: -b.z, w: -b.w } : b;
  if (dot < 0) dot = -dot;
  const theta0 = Math.acos(dot);
  const s = Math.sin(theta0);
  if (s < 1e-12) {
    // Same rotation (the antipodal case was flipped above): no arc to walk.
    return { x: a.x, y: a.y, z: a.z, w: a.w };
  }
  const so = Math.sin(theta0 * tt) / s;
  const sa = Math.sin(theta0 * (1 - tt)) / s;
  return quatNormalize({
    x: a.x * sa + bb.x * so,
    y: a.y * sa + bb.y * so,
    z: a.z * sa + bb.z * so,
    w: a.w * sa + bb.w * so,
  });
}

/** Apply unit quaternion q to vector v (q rotates, q⁻¹ does not apply). */
export function quatRotateVector(q: Quat, v: Vec3): Vec3 {
  const qv: Vec3 = { x: q.x, y: q.y, z: q.z };
  const t = vecScale(vecCross(qv, v), 2);
  return {
    x: v.x + q.w * t.x + vecCross(qv, t).x,
    y: v.y + q.w * t.y + vecCross(qv, t).y,
    z: v.z + q.w * t.z + vecCross(qv, t).z,
  };
}
