import { boundaryFactor, dragAcceleration, dragCoefficient } from './atmosphere.ts';
import { regimeBandTop, type Body } from './bodies.ts';
import {
  GROUND_EPSILON_M,
  GROUND_FRICTION,
  MAX_STEP_DISTANCE_M,
  MAX_SUBSTEPS,
  PAD_MAX_HORIZONTAL_SPEED,
  PAD_MAX_VERTICAL_SPEED,
  PAD_RADIUS_M,
  SURFACE_GRAVITY,
  VTOL_ACCEL_FRACTION,
  VTOL_CLIMB_RATE,
  VTOL_DESCENT_RATE,
  VTOL_FULL_SPEED,
  VTOL_GAIN,
  VTOL_IDLE_SINK_RATE,
  VTOL_ZERO_SPEED,
} from './flightConstants.ts';
import type { FlightContext, FlightInput, ShipState, SurfaceProvider } from './flightTypes.ts';
import { bodyOfFrame, surfaceScale } from './frames.ts';
import { brakeBy, capVelocity, clampMagnitude } from './motion.ts';
import { FORWARD, UP } from './rotation.ts';
import { speedFactor } from './travel.ts';
import { add, length, rotateVector, scale, type Quat, type Vec3 } from './vec.ts';

/** VTOL authority in [0, 1]: full at low horizontal speed, fading linearly to zero at 60 m/s. */
export function vtolAuthority(horizontalSpeed: number): number {
  const span = VTOL_ZERO_SPEED - VTOL_FULL_SPEED;
  return Math.min(1, Math.max(0, (VTOL_ZERO_SPEED - horizontalSpeed) / span));
}

/** Vertical speed the hover assist holds: -3 m/s idle, +20 m/s at full up, -25 m/s at full down. */
export function desiredVerticalSpeed(up: number): number {
  return up >= 0
    ? -VTOL_IDLE_SINK_RATE + up * (VTOL_CLIMB_RATE + VTOL_IDLE_SINK_RATE)
    : -VTOL_IDLE_SINK_RATE + up * (VTOL_DESCENT_RATE - VTOL_IDLE_SINK_RATE);
}

const horizontalSpeed = (v: Vec3): number => Math.sqrt(v.x * v.x + v.z * v.z);

interface Substep {
  planet: Body;
  surface: SurfaceProvider;
  input: FlightInput;
  quat: Quat;
  ctx: FlightContext;
}

/** One substep of surface-frame flight of duration `h`: forces, soft cap, motion, terrain clamp. */
function substep(
  { planet, surface, input, quat, ctx }: Substep,
  pos: Vec3,
  vel: Vec3,
  h: number,
): { pos: Vec3; vel: Vec3 } {
  const cls = ctx.shipClass;
  const gravity = ctx.gravity ?? SURFACE_GRAVITY;
  const terrain = surface.heightAt(pos.x, pos.z);
  const height = Math.max(0, pos.y - terrain);
  const factor = speedFactor(height);
  const bf = boundaryFactor(pos.y, regimeBandTop(planet));

  // Thrust along the nose; `up` is ship-up thrust in space and VTOL (below) inside the atmosphere.
  const command = clampMagnitude(
    add(
      scale(rotateVector(quat, FORWARD), input.thrust),
      scale(rotateVector(quat, UP), input.up * (1 - bf)),
    ),
  );
  let accel = scale(command, cls.acceleration * factor);
  accel = add(accel, { x: 0, y: -gravity * bf, z: 0 });
  if (planet.atmosphere) {
    const k = dragCoefficient(planet.atmosphere.density, cls.mass) * bf;
    accel = add(accel, dragAcceleration(vel, k));
  }
  if (ctx.assist !== false && bf > 0) {
    const climbAccel = cls.acceleration * VTOL_ACCEL_FRACTION;
    const wanted = gravity * bf + VTOL_GAIN * (desiredVerticalSpeed(input.up) - vel.y);
    const thrust = Math.min(climbAccel, Math.max(0, wanted));
    accel = add(accel, { x: 0, y: thrust * vtolAuthority(horizontalSpeed(vel)) * bf, z: 0 });
  }

  let v = add(vel, scale(accel, h));
  if (input.brake) {
    const flat = brakeBy({ x: v.x, y: 0, z: v.z }, cls.acceleration * factor * h);
    v = { x: flat.x, y: v.y, z: flat.z };
  }
  v = capVelocity(v, cls.maxVelocity * factor, h);

  // Velocity is true m/s; flat chart metres are 1/scale true metres, so horizontal motion is
  // divided by the local chart scale. Altitude is true metres already.
  const chart = surfaceScale(planet, pos);
  const p0 = { x: pos.x + (v.x * h) / chart, y: pos.y + v.y * h, z: pos.z + (v.z * h) / chart };
  let p = p0;

  const ground = surface.heightAt(p.x, p.z);
  if (p.y <= ground) {
    p = { ...p, y: ground };
    if (v.y < 0) v = { ...v, y: 0 };
  }
  if (p.y - ground <= GROUND_EPSILON_M) {
    const flat = brakeBy({ x: v.x, y: 0, z: v.z }, GROUND_FRICTION * h);
    v = { x: flat.x, y: v.y, z: flat.z };
  }
  return { pos: p, vel: v };
}

/** The pad the ship is resting on (on the ground, slow, within the true pad radius), if any. */
function detectPad(
  pos: Vec3,
  vel: Vec3,
  surface: SurfaceProvider,
  chart: number,
): string | undefined {
  const onGround = pos.y - surface.heightAt(pos.x, pos.z) <= GROUND_EPSILON_M;
  if (!onGround || Math.abs(vel.y) >= PAD_MAX_VERTICAL_SPEED) return undefined;
  if (horizontalSpeed(vel) >= PAD_MAX_HORIZONTAL_SPEED) return undefined;
  return surface.pads.find((pad) => {
    const dx = (pad.x - pos.x) * chart;
    const dz = (pad.z - pos.z) * chart;
    return dx * dx + dz * dz <= PAD_RADIUS_M * PAD_RADIUS_M;
  })?.id;
}

/**
 * Surface-frame flight: gravity along -y and quadratic drag (both ramped by the shared atmosphere
 * boundary), VTOL hover assist below 60 m/s horizontal, terrain collision through the injected
 * `heightAt` with substeps so no step moves more than ~2 m, and pad detection. Positions are
 * flat chart metres; velocities, distances and radii are true metres (see frames.ts).
 */
export function integrateSurface(
  state: ShipState,
  input: FlightInput,
  dt: number,
  ctx: FlightContext,
  quat: Quat,
): ShipState {
  const planet = bodyOfFrame(state.frame, ctx.bodies);
  if (!planet || !ctx.surface) throw new RangeError(`no surface context for frame ${state.frame}`);
  const surface = ctx.surface;
  const steps = Math.min(
    MAX_SUBSTEPS,
    Math.max(1, Math.ceil((length(state.vel) * dt) / MAX_STEP_DISTANCE_M)),
  );
  const h = dt / steps;
  const context: Substep = { planet, surface, input, quat, ctx };
  let pos = state.pos;
  let vel = state.vel;
  for (let i = 0; i < steps; i++) ({ pos, vel } = substep(context, pos, vel, h));

  const next: ShipState = { ...state, pos, vel, quat };
  delete next.onPad;
  const onPad = detectPad(pos, vel, surface, surfaceScale(planet, pos));
  if (onPad) next.onPad = onPad;
  return next;
}
