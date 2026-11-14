import type { FramePosition } from '../protocol/primitives.ts';
import { chartRadiusSq, chartScale, chartToUnit, type Hemisphere } from '../galaxy/chart.ts';
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

/**
 * A reference frame: the system frame, or one of a landable planet's two surface charts,
 * written `<planetId>:n` or `<planetId>:s`.
 */
export type FrameId = FramePosition['frame'];
export const SYSTEM_FRAME: FrameId = 'system';

/** The planet and hemisphere a surface frame id names. */
export interface SurfaceFrameRef {
  planetId: string;
  hemisphere: Hemisphere;
}

/** Builds the frame id of a planet's chart. */
export function surfaceFrameId(planetId: string, hemisphere: Hemisphere): FrameId {
  return `${planetId}:${hemisphere}` as FrameId;
}

/** Splits a surface frame id; undefined for the system frame. */
export function parseFrame(frame: FrameId): SurfaceFrameRef | undefined {
  if (frame === SYSTEM_FRAME) return undefined;
  return { planetId: frame.slice(0, 16), hemisphere: frame.endsWith(':s') ? 's' : 'n' };
}

/**
 * Surface frame = one stereographic chart of the planet (see galaxy/chart.ts): flat x and z are
 * chart metres, y is true altitude above the datum sphere. Velocities and orientations in a
 * surface frame are TRUE metres per second in the local orthonormal basis (flat x, up, flat z);
 * the chart is conformal, so that basis is orthogonal on the sphere too. Only horizontal
 * position integration needs the chart scale. This is sim code: sqrt and trig are allowed here.
 */

/** Unit direction from the body centre and distance of a system-frame point. */
function directionOf(body: Body, p: Vec3): { n: Vec3; rho: number } {
  const rel = sub(p, body.center);
  const rho = length(rel);
  if (rho === 0) return { n: { x: 0, y: 1, z: 0 }, rho };
  return { n: scale(rel, 1 / rho), rho };
}

/** The hemisphere a system-frame point lies over (north when exactly on the equator). */
export function hemisphereOf(body: Body, systemPos: Vec3): Hemisphere {
  return systemPos.y - body.center.y >= 0 ? 'n' : 's';
}

/**
 * Sine of the latitude of a system-frame point measured towards the pole of `hemisphere`:
 * 1 at that pole, 0 on the equator, negative in the other hemisphere.
 */
export function poleward(body: Body, hemisphere: Hemisphere, systemPos: Vec3): number {
  const { n } = directionOf(body, systemPos);
  return hemisphere === 'n' ? n.y : -n.y;
}

/** Local chart scale (true metres per flat metre) at a surface-frame position. */
export function surfaceScale(body: Body, flat: Vec3): number {
  return chartScale(chartRadiusSq(body.radius, flat.x, flat.z));
}

/** System-frame position -> surface-frame position in the given chart. */
export function systemToSurface(body: Body, hemisphere: Hemisphere, systemPos: Vec3): Vec3 {
  const { n, rho } = directionOf(body, systemPos);
  const sign = hemisphere === 'n' ? 1 : -1;
  const denom = 1 + sign * n.y;
  if (denom <= 0) throw new RangeError('point is at the antipode of this chart');
  const k = (2 * body.radius) / denom;
  return { x: k * n.x, y: rho - body.radius, z: k * sign * n.z };
}

/** Surface-frame position -> system-frame position (inverse of `systemToSurface`). */
export function surfaceToSystem(body: Body, hemisphere: Hemisphere, flat: Vec3): Vec3 {
  const n = chartToUnit(hemisphere, body.radius, flat.x, flat.z);
  return add(body.center, scale(n, body.radius + flat.y));
}

/**
 * The rotation L taking surface-frame vectors to system-frame vectors at a surface point: its
 * columns are the unit tangent along flat x, the outward normal, and the unit tangent along
 * flat z - an orthonormal right-handed set, so vectors keep their length.
 */
export function surfaceBasis(body: Body, hemisphere: Hemisphere, flat: Vec3): Mat3 {
  const a = flat.x / (2 * body.radius);
  const b = flat.z / (2 * body.radius);
  const q = 1 + a * a + b * b;
  const s = hemisphere === 'n' ? 1 : -1;
  const lx = { x: (1 - a * a + b * b) / q, y: (-s * 2 * a) / q, z: (-s * 2 * a * b) / q };
  const lz = { x: (-2 * a * b) / q, y: (-s * 2 * b) / q, z: (s * (1 + a * a - b * b)) / q };
  const up = { x: (2 * a) / q, y: (s * (2 - q)) / q, z: (s * 2 * b) / q };
  return [lx.x, up.x, lz.x, lx.y, up.y, lz.y, lx.z, up.z, lz.z];
}

/** Rotation quaternion of the surface-to-system basis at a surface point. */
export function surfaceBasisQuat(body: Body, hemisphere: Hemisphere, flat: Vec3): Quat {
  return fromMat3(surfaceBasis(body, hemisphere, flat));
}

/** Rotates a surface-frame direction/velocity into the system frame (length preserved). */
export function surfaceVectorToSystem(
  body: Body,
  hemisphere: Hemisphere,
  flat: Vec3,
  v: Vec3,
): Vec3 {
  return mulMat3(surfaceBasis(body, hemisphere, flat), v);
}

/** Rotates a system-frame direction/velocity into the surface frame (length preserved). */
export function systemVectorToSurface(
  body: Body,
  hemisphere: Hemisphere,
  flat: Vec3,
  v: Vec3,
): Vec3 {
  const m = surfaceBasis(body, hemisphere, flat);
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
function convertOne(
  body: Body,
  hemisphere: Hemisphere,
  k: Kinematics,
  toSurface: boolean,
): Kinematics {
  if (toSurface) {
    const flat = systemToSurface(body, hemisphere, k.pos);
    const basis = surfaceBasisQuat(body, hemisphere, flat);
    return {
      pos: flat,
      vel: systemVectorToSurface(body, hemisphere, flat, k.vel),
      quat: normalizeQuat(multiply(conjugate(basis), k.quat)),
    };
  }
  const basis = surfaceBasisQuat(body, hemisphere, k.pos);
  return {
    pos: surfaceToSystem(body, hemisphere, k.pos),
    vel: surfaceVectorToSystem(body, hemisphere, k.pos, k.vel),
    quat: normalizeQuat(multiply(basis, k.quat)),
  };
}

/**
 * Converts position, velocity and orientation from frame `from` to frame `to` (the system frame
 * or a surface chart of a body in `bodies`), going through the system frame when both are charts.
 * @throws RangeError for an unknown frame id.
 */
export function convertKinematics(
  k: Kinematics,
  from: FrameId,
  to: FrameId,
  bodies: readonly Body[],
): Kinematics {
  if (from === to) return k;
  const convert = (frame: FrameId, input: Kinematics, toSurface: boolean): Kinematics => {
    const ref = parseFrame(frame);
    const body = ref && bodies.find((b) => b.id === ref.planetId && b.hasSurfaceFrame);
    if (!ref || !body) throw new RangeError(`unknown surface frame: ${frame}`);
    return convertOne(body, ref.hemisphere, input, toSurface);
  };
  const inSystem = from === SYSTEM_FRAME ? k : convert(from, k, false);
  return to === SYSTEM_FRAME ? inSystem : convert(to, inSystem, true);
}

/** The body a surface frame belongs to, if the frame is a chart of one of `bodies`. */
export function bodyOfFrame(frame: FrameId, bodies: readonly Body[]): Body | undefined {
  const ref = parseFrame(frame);
  return ref ? bodies.find((b) => b.id === ref.planetId) : undefined;
}
