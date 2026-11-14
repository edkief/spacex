/** Plain-object vector, quaternion and 3x3 matrix math (no dependencies, no allocation tricks). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unit quaternion (x, y, z, w). Rotates local vectors into the parent frame. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Row-major 3x3 matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22]. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
export const QUAT_IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const lengthSq = (a: Vec3): number => dot(a, a);
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(scale(a, 1 - t), scale(b, t));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/** Normalises a vector; returns `fallback` (default +y) for a zero-length input. */
export function normalize(a: Vec3, fallback: Vec3 = { x: 0, y: 1, z: 0 }): Vec3 {
  const len = length(a);
  return len > 0 ? scale(a, 1 / len) : fallback;
}

/** Hamilton product `a * b`: applies `b` first, then `a`. */
export function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export const conjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/** Normalises a quaternion; identity for a degenerate input. */
export function normalizeQuat(q: Quat): Quat {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  return len > 0 ? { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len } : QUAT_IDENTITY;
}

/** Rotation of `angle` radians about a unit `axis`. */
export function fromAxisAngle(axis: Vec3, angle: number): Quat {
  const half = angle / 2;
  const s = Math.sin(half);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
}

/** Shortest rotation taking unit direction `from` to unit direction `to`. */
export function fromToQuat(from: Vec3, to: Vec3): Quat {
  const axis = cross(from, to);
  const sine = length(axis);
  const cosine = dot(from, to);
  if (sine < 1e-12) {
    if (cosine > 0) return QUAT_IDENTITY;
    // Opposite directions: half-turn about any axis perpendicular to `from`.
    const perpendicular = Math.abs(from.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    return fromAxisAngle(normalize(cross(from, perpendicular)), Math.PI);
  }
  return fromAxisAngle(scale(axis, 1 / sine), Math.atan2(sine, cosine));
}

/** Rotates `v` by the unit quaternion `q`. */
export function rotateVector(q: Quat, v: Vec3): Vec3 {
  const t = scale(cross({ x: q.x, y: q.y, z: q.z }, v), 2);
  return add(add(v, scale(t, q.w)), cross({ x: q.x, y: q.y, z: q.z }, t));
}

/** Rotation matrix of a unit quaternion. */
export function toMat3(q: Quat): Mat3 {
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

/** Unit quaternion of a proper rotation matrix (Shepperd's method). */
export function fromMat3(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
  }
  return normalizeQuat(q);
}

/** Matrix-vector product. */
export function mulMat3(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

/** Transpose (the inverse of a rotation matrix). */
export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
