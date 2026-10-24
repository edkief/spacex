export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

export const vec3 = {
  add: (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  dot: (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a: Vec3, b: Vec3): Vec3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  lenSq: (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z,
  len: (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
  normalize: (a: Vec3): Vec3 => {
    const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (l === 0) return { x: 0, y: 0, z: 0 };
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  }),
};

export const quat = {
  /**
   * Creates a quaternion from Euler angles (pitch, yaw, roll) in radians.
   * Pitch: X axis, Yaw: Y axis, Roll: Z axis.
   */
  fromEuler: (pitch: number, yaw: number, roll: number): Quat => {
    const cx = Math.cos(pitch * 0.5);
    const sx = Math.sin(pitch * 0.5);
    const cy = Math.cos(yaw * 0.5);
    const sy = Math.sin(yaw * 0.5);
    const cz = Math.cos(roll * 0.5);
    const sz = Math.sin(roll * 0.5);

    return {
      x: sx * cy * cz - cx * sy * sz,
      y: cx * sy * cz + sx * cy * sz,
      z: cx * cy * sz - sx * sy * cz,
      w: cx * cy * cz + sx * sy * sz,
    };
  },

  multiply: (q1: Quat, q2: Quat): Quat => ({
    x: q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
    y: q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,
    z: q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,
    w: q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z,
  }),

  rotateVector: (q: Quat, v: Vec3): Vec3 => {
    const { x, y, z, w } = q;
    const { x: vx, y: vy, z: vz } = v;

    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);

    return {
      x: vx + w * tx + (y * tz - z * ty),
      y: vy + w * ty + (z * tx - x * tz),
      z: vz + w * tz + (x * ty - y * tx),
    };
  },

  toMat3: (q: Quat): number[][] => {
    const { x, y, z, w } = q;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;

    return [
      [1 - (yy + zz), xy - wz, xz + wy],
      [xy + wz, 1 - (xx + zz), yz - wx],
      [xz - wy, yz + wx, 1 - (xx + yy)],
    ];
  },
};
