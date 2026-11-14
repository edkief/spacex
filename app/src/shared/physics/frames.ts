import type { FramePosition } from '../protocol/primitives.ts';
import type { Body } from './bodies.ts';
import {
  conjugate,
  fromMat3,
  mulMat3,
  multiply,
  normalizeQuat,
  type Mat3,
  type Quat,
  type Vec3,
  add,
  sub,
  scale,
  length,
} from './vec.ts';
import { MAX_COLATITUDE } from './worldConstants.ts';

/** A reference frame: the system frame, or a landable planet's surface frame (its id). */
export type FrameId = FramePosition['frame'];
export const SYSTEM_FRAME: FrameId = 'system';

/**
 * Surface frame = azimuthal-equidistant projection of the sphere about the planet's +y pole.
 * For a system-frame point at distance rho from the centre, colatitude theta from +y and
 * azimuth phi: x = R*theta*cos(phi), z = R*theta*sin(phi), y = rho - R. This is sim code, so the
 * trigonometric functions are allowed here (unlike in generation).
 */

/** Polar coordinates of a point relative to the planet centre. */
interface Polar {
  rho: number;
  theta: number;
  cosPhi: number;
  sinPhi: number;
}

/** Colatitude, azimuth (as cos/sin; (1, 0) at the poles) and distance of a system-frame point. */
function polarOf(body: Body, p: Vec3): Polar {
  const rel = sub(p, body.center);
  const rho = length(rel);
  const horizontal = Math.sqrt(rel.x * rel.x + rel.z * rel.z);
  const theta = Math.atan2(horizontal, rel.y);
  if (horizontal === 0) return { rho, theta, cosPhi: 1, sinPhi: 0 };
  return { rho, theta, cosPhi: rel.x / horizontal, sinPhi: rel.z / horizontal };
}

/** Colatitude (radians from the +y pole) of a system-frame point about the body. */
export function colatitude(body: Body, systemPos: Vec3): number {
  return polarOf(body, systemPos).theta;
}

/** True when the point is inside the usable range of the surface projection (theta <= 0.97 pi). */
export function inSurfaceRange(body: Body, systemPos: Vec3): boolean {
  return colatitude(body, systemPos) <= MAX_COLATITUDE;
}

/** Maximum flat radius (metres) of the surface frame: R * 0.97 pi. */
export function maxFlatRadius(body: Body): number {
  return body.radius * MAX_COLATITUDE;
}

/** Azimuthal stretch of the projection at colatitude theta: theta / sin(theta) (1 at the pole). */
export function azimuthalStretch(theta: number): number {
  return theta < 1e-9 ? 1 : theta / Math.sin(theta);
}

/** System-frame position -> surface-frame position. */
export function systemToSurface(body: Body, systemPos: Vec3): Vec3 {
  const { rho, theta, cosPhi, sinPhi } = polarOf(body, systemPos);
  const flatRadius = body.radius * theta;
  return { x: flatRadius * cosPhi, y: rho - body.radius, z: flatRadius * sinPhi };
}

/** Surface-frame position -> system-frame position (inverse of `systemToSurface`). */
export function surfaceToSystem(body: Body, flat: Vec3): Vec3 {
  const rFlat = Math.sqrt(flat.x * flat.x + flat.z * flat.z);
  const theta = rFlat / body.radius;
  const cosPhi = rFlat > 0 ? flat.x / rFlat : 1;
  const sinPhi = rFlat > 0 ? flat.z / rFlat : 0;
  const rho = body.radius + flat.y;
  const sinTheta = Math.sin(theta);
  return add(body.center, {
    x: rho * sinTheta * cosPhi,
    y: rho * Math.cos(theta),
    z: rho * sinTheta * sinPhi,
  });
}

/**
 * The rotation L taking surface-frame vectors to system-frame vectors at a surface point. It
 * maps (flat radial, flat azimuthal, +y) onto (away-from-pole, azimuthal, up), an orthonormal
 * right-handed set, so vectors keep their length: the projection's stretch is NOT applied.
 */
export function surfaceBasis(body: Body, flat: Vec3): Mat3 {
  const rFlat = Math.sqrt(flat.x * flat.x + flat.z * flat.z);
  const theta = rFlat / body.radius;
  const cosPhi = rFlat > 0 ? flat.x / rFlat : 1;
  const sinPhi = rFlat > 0 ? flat.z / rFlat : 0;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  // Columns: images of flat x, y, z. e_theta = (cosT cosPhi, -sinT, cosT sinPhi),
  // e_phi = (-sinPhi, 0, cosPhi), up = (sinT cosPhi, cosT, sinT sinPhi).
  const eTheta = { x: cosT * cosPhi, y: -sinT, z: cosT * sinPhi };
  const ePhi = { x: -sinPhi, y: 0, z: cosPhi };
  const up = { x: sinT * cosPhi, y: cosT, z: sinT * sinPhi };
  const lx = add(scale(eTheta, cosPhi), scale(ePhi, -sinPhi));
  const lz = add(scale(eTheta, sinPhi), scale(ePhi, cosPhi));
  return [lx.x, up.x, lz.x, lx.y, up.y, lz.y, lx.z, up.z, lz.z];
}

/** Rotation quaternion of the surface-to-system basis at a surface point. */
export function surfaceBasisQuat(body: Body, flat: Vec3): Quat {
  return fromMat3(surfaceBasis(body, flat));
}

/** Rotates a surface-frame direction/velocity into the system frame (length preserved). */
export function surfaceVectorToSystem(body: Body, flat: Vec3, v: Vec3): Vec3 {
  return mulMat3(surfaceBasis(body, flat), v);
}

/** Rotates a system-frame direction/velocity into the surface frame (length preserved). */
export function systemVectorToSurface(body: Body, flat: Vec3, v: Vec3): Vec3 {
  const m = surfaceBasis(body, flat);
  // The inverse of a rotation is its transpose.
  return {
    x: m[0] * v.x + m[3] * v.y + m[6] * v.z,
    y: m[1] * v.x + m[4] * v.y + m[7] * v.z,
    z: m[2] * v.x + m[5] * v.y + m[8] * v.z,
  };
}

/** Position, velocity and orientation of a body of the sim in some frame. */
export interface Kinematics {
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
}

/** Converts kinematics between the system frame and a body's surface frame. */
function convertOne(body: Body, k: Kinematics, toSurface: boolean): Kinematics {
  if (toSurface) {
    const flat = systemToSurface(body, k.pos);
    const basis = surfaceBasisQuat(body, flat);
    return {
      pos: flat,
      vel: systemVectorToSurface(body, flat, k.vel),
      quat: normalizeQuat(multiply(conjugate(basis), k.quat)),
    };
  }
  const basis = surfaceBasisQuat(body, k.pos);
  return {
    pos: surfaceToSystem(body, k.pos),
    vel: surfaceVectorToSystem(body, k.pos, k.vel),
    quat: normalizeQuat(multiply(basis, k.quat)),
  };
}

/**
 * Converts position, velocity and orientation from frame `from` to frame `to` (either the system
 * frame or a body id from `bodies`), going through the system frame when both are surface frames.
 * @throws RangeError for an unknown frame id.
 */
export function convertKinematics(
  k: Kinematics,
  from: FrameId,
  to: FrameId,
  bodies: readonly Body[],
): Kinematics {
  if (from === to) return k;
  const find = (id: string): Body => {
    const body = bodies.find((b) => b.id === id && b.hasSurfaceFrame);
    if (!body) throw new RangeError(`unknown surface frame: ${id}`);
    return body;
  };
  const inSystem = from === SYSTEM_FRAME ? k : convertOne(find(from), k, false);
  return to === SYSTEM_FRAME ? inSystem : convertOne(find(to), inSystem, true);
}
