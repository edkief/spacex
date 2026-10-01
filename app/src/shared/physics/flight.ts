/**
 * Shared flight model (TASK-22) — deterministic ship physics.
 *
 * Used VERBATIM by the server sim (authority) and the client prediction
 * (TASK-14): the server ticks at a fixed dt (1/20 s); the client may call
 * with a variable dt for prediction, but it must use this exact function
 * so both state streams stay bit-identical.
 *
 * `integrateShip` is a pure function: same (state, input, dt, regime,
 * planet, shipClass, options) → identical ShipState. No Math.random, no
 * side effects, no allocation of shared mutable state.
 *
 * Units: 1 u ≈ 1 m, velocities in u/s, angles in radians.
 * Regimes (TASK-25: the shared Regime union gained 'surface'):
 * - 'space': thrust along the ship's forward axis, no drag, rotation at
 *   turnRate, soft speed cap (excess above maxVelocity decays 5%/step).
 * - 'atmosphere': quadratic drag (k·|v|·v, opposing velocity), gravity,
 *   VTOL vertical lift, ground collision at terrain height (substepped so
 *   fast ships never tunnel: substep whenever |vel|·dt > 2 u). Drag ramps
 *   0→k across the 1 km boundary band (see ./atmosphere, shared with
 *   TASK-28).
 * - 'surface': landed. Integrates with the same atmosphere physics (drag,
 *   gravity, VTOL, ground clamp), so a landed ship rests on the terrain and
 *   can VTOL-lift off; the regime manager (../regime) flips it back to
 *   'atmosphere' once it climbs out of the surface hysteresis band.
 *
 * Planet-agnostic by design: atmosphere density arrives as a plain
 * `PlanetAtmo` (the server derives it from the generated Planet), and
 * terrain arrives as a caller-injected `heightAt(x, z)` callback (the
 * server wires the chunk-based surface lookup; tests use analytic terrain).
 */

import type { ShipClass, ShipClassId } from '../ships';
import { shipStats } from '../ships';
import { atmosphereFactor } from './atmosphere';
import {
  quatFromEuler,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatRotateVector,
  vecAdd,
  vecCross,
  vecDot,
  vecLength,
  vecNormalize,
  vecScale,
  vecSub,
  type Quat,
  type Vec3,
} from './vec';

/** Flight regimes the model knows (TASK-25: space/atmosphere/surface). */
export type Regime = import('../regime').Regime;

/** Thrown when integrateShip receives a regime it cannot integrate. */
export class UnknownRegimeError extends Error {
  readonly regime: string;

  constructor(regime: string) {
    super(`unknown flight regime: ${regime}`);
    this.name = 'UnknownRegimeError';
    this.regime = regime;
  }
}

/** Full kinematic state of one ship (the sim's authority record). */
export interface ShipState {
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  regime: Regime;
  /** Pad id when docked on a landing pad (set by VTOL landing logic). */
  onPad?: string;
}

/** Per-tick control input. All channels are [-1, 1] (up is [0, 1]). */
export interface ShipInput {
  /** Main thruster: -1..1, thrust along the ship's forward (+Z) axis. */
  thrust: number;
  /** Yaw rate demand, -1..1 (scaled by the class turnRate). */
  yaw: number;
  /** Pitch rate demand, -1..1. */
  pitch: number;
  /** Roll rate demand, -1..1. */
  roll: number;
  /** VTOL lift demand, 0..1 (atmosphere only). */
  up: number;
}

/**
 * Minimal planet surface the flight model needs. Structurally typed: the
 * server derives `atmosphereDensity` from the generated Planet (0 for
 * airless bodies), tests pass a bare number holder.
 */
export interface PlanetAtmo {
  /** Drag density of the atmosphere (0 = none). */
  atmosphereDensity: number;
}

/** A landing pad for VTOL docking, in planet-surface coordinates. */
export interface LandingPadRef {
  id: string;
  x: number;
  z: number;
}

/** Caller-injected environment (planet-agnostic seams). */
export interface FlightOptions {
  /**
   * Terrain height at (x, z), in u. Defaults to flat ground at y = 0.
   * The server injects the chunk-based surface lookup; tests use an
   * analytic function.
   */
  heightAt?: (x: number, z: number) => number;
  /** Pads the ship can VTOL-land on. Defaults to none. */
  pads?: LandingPadRef[];
}

/** Gravity in the atmosphere regime (u/s²). */
export const GRAVITY = 9.8;
/**
 * VTOL lift at input.up = 1 (u/s²). Equals GRAVITY: full VTOL demand makes
 * the ship neutrally buoyant, so hover converges to vel.y = 0 (drag damps
 * any residual vertical velocity).
 */
export const VTOL_LIFT = GRAVITY;
/** Max horizontal speed (u/s) at which VTOL lift still applies. */
export const VTOL_HORIZONAL_LIMIT = 5;
/** Per-step decay of the speed excess above maxVelocity (soft cap). */
export const SOFT_CAP_DECAY = 0.95;
/** Substep when |vel|·dt exceeds this travel (u) to avoid ground tunneling. */
export const SUBSTEP_MAX_TRAVEL_M = 2;
/** Radius (u) of a landing pad for docking. */
export const PAD_RADIUS = 4;
/** Max |vel.y| (u/s) for a ship to count as settled on a pad. */
export const ONPAD_VERTICAL_THRESHOLD = 1;

const FORWARD: Vec3 = { x: 0, y: 0, z: 1 };

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Effective cross-section area (u²) of a class: grows with mass. */
export function crossSectionArea(cls: ShipClass): number {
  return 2 * Math.sqrt(cls.mass);
}

/**
 * Per-mass quadratic drag coefficient k (1/u): a_drag = -k·|v|·v.
 * k = atmosphereDensity · area / mass.
 */
export function dragCoefficient(planet: PlanetAtmo | undefined, cls: ShipClass): number {
  if (!planet) return 0;
  return (planet.atmosphereDensity * crossSectionArea(cls)) / cls.mass;
}

function resolveClass(shipClass: ShipClass | ShipClassId): ShipClass {
  return typeof shipClass === 'string' ? shipStats(shipClass) : shipClass;
}

function defaultHeightAt(): (x: number, z: number) => number {
  return () => 0;
}

/**
 * Integrate one ship forward by dt. Pure and deterministic.
 *
 * @param state     current kinematic state (never mutated)
 * @param input     control input this tick (channels clamped to [-1, 1])
 * @param dt        timestep in seconds (must be > 0 and finite)
 * @param regime    'space' | 'atmosphere'; anything else throws
 *                  {@link UnknownRegimeError}
 * @param planet    atmosphere source (density); omit for no atmosphere
 * @param shipClass class id or class object (stats: mass, maxVelocity,
 *                  acceleration, turnRate)
 * @param options   terrain heightAt + pads (defaults: flat ground, no pads)
 * @returns the new ShipState (regime set to the regime passed in; onPad set
 *          when VTOL-landed on a pad, undefined otherwise)
 */
export function integrateShip(
  state: ShipState,
  input: ShipInput,
  dt: number,
  regime: Regime,
  planet?: PlanetAtmo,
  shipClass?: ShipClass | ShipClassId,
  options?: FlightOptions,
): ShipState {
  if (regime !== 'space' && regime !== 'atmosphere' && regime !== 'surface') {
    throw new UnknownRegimeError(String(regime));
  }
  if (!(dt > 0) || !Number.isFinite(dt)) {
    throw new Error(`dt must be a positive finite number of seconds, got ${dt}`);
  }
  if (shipClass === undefined) {
    throw new Error('shipClass is required');
  }
  const cls = resolveClass(shipClass);
  const heightAt = options?.heightAt ?? defaultHeightAt();
  const k = dragCoefficient(planet, cls);

  const clamped: ShipInput = {
    thrust: clampUnit(input.thrust),
    yaw: clampUnit(input.yaw),
    pitch: clampUnit(input.pitch),
    roll: clampUnit(input.roll),
    up: clampUnit(input.up),
  };

  // Substep so no single step travels more than SUBSTEP_MAX_TRAVEL_M —
  // guarantees ground collision can never tunnel at high speed.
  const travel = vecLength(state.vel) * dt;
  const steps = Math.max(1, Math.ceil(travel / SUBSTEP_MAX_TRAVEL_M));
  const h = dt / steps;

  let s: ShipState = {
    pos: { ...state.pos },
    vel: { ...state.vel },
    quat: { ...state.quat },
    regime,
  };
  for (let i = 0; i < steps; i++) {
    s = integrateStep(s, clamped, h, regime, k, cls, heightAt);
  }

  // Soft speed cap (once per tick, independent of substepping): the excess
  // above maxVelocity decays SOFT_CAP_DECAY per step.
  const speed = vecLength(s.vel);
  if (speed > cls.maxVelocity) {
    const over = speed - cls.maxVelocity;
    const back = vecScale(vecNormalize(s.vel), over * (1 - SOFT_CAP_DECAY));
    s = { ...s, vel: vecSub(s.vel, back) };
  }

  const onPad = findPad(s, options?.pads ?? [], heightAt);
  if (onPad !== undefined) {
    s = { ...s, onPad };
  }
  return s;
}

/** One substep of physics (rotation, forces, motion, ground clamp). */
function integrateStep(
  s: ShipState,
  input: ShipInput,
  h: number,
  regime: Regime,
  k: number,
  cls: ShipClass,
  heightAt: (x: number, z: number) => number,
): ShipState {
  // Rotation: angular velocity = demand × turnRate, applied about the
  // ship's local axes (yaw Y, pitch X, roll Z).
  const dRot = quatFromEuler(
    input.yaw * cls.turnRate * h,
    input.pitch * cls.turnRate * h,
    input.roll * cls.turnRate * h,
  );
  const quat = quatNormalize(quatMultiply(s.quat, dRot));

  let vel = { ...s.vel };

  if (regime === 'space') {
    // Pure Newtonian: thrust along the forward axis, no drag, no damping.
    const forward = quatRotateVector(quat, FORWARD);
    vel = vecAdd(vel, vecScale(forward, input.thrust * cls.acceleration * h));
  } else {
    // Quadratic drag opposing velocity, ramped across the 1 km boundary.
    const groundY = heightAt(s.pos.x, s.pos.z);
    const factor = atmosphereFactor(s.pos.y - groundY);
    const speed = vecLength(vel);
    vel = vecAdd(vel, vecScale(vel, -k * factor * speed * h));
    // Gravity.
    vel.y -= GRAVITY * h;
    // VTOL lift: vertical, heading-independent, only near hover speed.
    if (input.up > 0) {
      const hSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      if (hSpeed < VTOL_HORIZONAL_LIMIT) {
        vel.y += input.up * VTOL_LIFT * h;
      }
    }
  }

  const pos = vecAdd(s.pos, vecScale(vel, h));

  // Ground collision (atmosphere regime only): clamp to terrain, kill
  // downward velocity. Substepping above keeps travel ≤ 2 u per step, so
  // the clamp can never skip over the surface (no tunneling).
  if (regime !== 'space') {
    // 'atmosphere' and 'surface' both clamp to terrain (a landed ship rests
    // on it; VTOL lift in the 'surface' regime is what gets it back up).
    const groundY = heightAt(pos.x, pos.z);
    if (pos.y <= groundY) {
      pos.y = groundY;
      if (vel.y < 0) vel.y = 0;
    }
  }

  return { pos, vel, quat, regime: s.regime };
}

/** Pad id if the ship is settled on a pad, else undefined. */
function findPad(
  s: ShipState,
  pads: LandingPadRef[],
  heightAt: (x: number, z: number) => number,
): string | undefined {
  if (s.regime !== 'atmosphere' && s.regime !== 'surface') return undefined;
  const groundY = heightAt(s.pos.x, s.pos.z);
  const onGround = s.pos.y <= groundY + 1e-3;
  if (!onGround) return undefined;
  if (Math.abs(s.vel.y) >= ONPAD_VERTICAL_THRESHOLD) return undefined;
  const hSpeed2 = s.vel.x * s.vel.x + s.vel.z * s.vel.z;
  if (hSpeed2 >= VTOL_HORIZONAL_LIMIT * VTOL_HORIZONAL_LIMIT) return undefined;
  const r2 = PAD_RADIUS * PAD_RADIUS;
  for (const pad of pads) {
    const dx = s.pos.x - pad.x;
    const dz = s.pos.z - pad.z;
    if (dx * dx + dz * dz <= r2) return pad.id;
  }
  return undefined;
}

/** Identity state helper: ship at rest, facing +Z. */
export function restShipState(pos: Vec3, regime: Regime, quat: Quat = quatIdentity()): ShipState {
  return {
    pos: { ...pos },
    vel: { x: 0, y: 0, z: 0 },
    quat: { ...quat },
    regime,
  };
}

/** Convenience: horizontal speed squared (pad/VTOL checks). */
export function horizontalSpeedSquared(vel: Vec3): number {
  return vel.x * vel.x + vel.z * vel.z;
}

// Re-exported so sim code can build inputs without importing vec directly.
export { vecAdd, vecCross, vecDot, vecLength, vecScale, vecSub };
