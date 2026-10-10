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
 *   turnRate. Speed cap (TASK-81): thrust never exceeds maxVelocity (it can
 *   only redirect velocity at top speed); any excess from elsewhere (a dive,
 *   a collision, a server correction) decays 5 %/tick (SOFT_CAP_DECAY).
 *   TASK-87: inside a landable airless planet's surface disc the surface is
 *   SOLID — the ship clamps to terrain (no tunnel-through) and friction
 *   (SURFACE_FRICTION, standing in for the missing drag) stops it there.
 * - 'atmosphere': quadratic drag (k·|v|·v, opposing velocity), main thruster
 *   along the ship's forward axis (TASK-98 — the same push + TASK-81
 *   max-velocity clamp as space, so a planet is flyable AND escapable),
 *   gravity, VTOL vertical lift, ground collision at terrain height
 *   (substepped so fast ships never tunnel: substep whenever |vel|·dt > 2 u).
 *   Drag ramps 0→k continuously from the atmosphere enter radius (space)
 *   down to the surface (see ./atmosphere — the single shared boundary
 *   function, TASK-28).
 * - 'surface': landed. Integrates with the same atmosphere physics (drag,
 *   thrust, gravity, VTOL, ground clamp), so a landed ship rests on the
 *   terrain, can taxi on the main thruster and VTOL-lift off; the regime
 *   manager (../regime) flips it back to 'atmosphere' once it climbs out of
 *   the surface hysteresis band (or speeds up).
 *
 * Planet-agnostic by design: atmosphere density arrives as a plain
 * `PlanetAtmo` (the server derives it from the generated Planet), and
 * terrain arrives as a caller-injected `heightAt(x, z)` callback (the
 * server wires the chunk-based surface lookup; tests use analytic terrain).
 */

import type { ShipClass, ShipClassId } from '../ships';
import { shipStats } from '../ships';
import type { SurfaceDisc } from '../galaxy/planets';
import { boundaryFactor } from './atmosphere';
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

/**
 * Per-tick control input. All channels are [-1, 1] (up is [0, 1]).
 *
 * PHYSICS CONVENTION (right-handed frame, +Y up, +Z forward — TASK-80):
 * positive YAW turns the nose toward local +X, which is a LEFT turn for
 * the chase camera (it looks along +Z, so screen-right is local -X);
 * positive ROLL is a positive rotation about +Z — CLOCKWISE seen from
 * behind, i.e. roll RIGHT; positive PITCH noses down. Key → on-screen
 * direction belongs to the input layer (the client's readInput translates
 * it; the server AI and the wire frame carry the raw convention).
 */
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
  /**
   * Space cruise boost demand, 0..1 (SHIFT, TASK-85). Engages the
   * × {@link CRUISE_SPEED_FACTOR} top speed / × {@link CRUISE_ACCEL_FACTOR}
   * acceleration only in the 'space' regime when
   * {@link FlightOptions.cruiseAllowed} is true; ignored everywhere else.
   * Optional: default 0 (every pre-TASK-85 call site behaves exactly as
   * before — the golden fixtures must not move).
   */
  boost?: number;
}

/**
 * Minimal planet surface the flight model needs. Structurally typed: the
 * server derives `atmosphereDensity` from the generated Planet (0 for
 * airless bodies), tests pass a bare number holder.
 */
export interface PlanetAtmo {
  /** Drag density of the atmosphere (0 = none). */
  atmosphereDensity: number;
  /** Atmosphere enter radius (u) — the drag-ramp band's top (see ./atmosphere). */
  atmosphereRadius: number;
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
  /**
   * Whether cruise boost is allowed at the ship's position (TASK-85, via
   * shared/regime `cruiseAllowedAt`). Defaults to false: a caller that
   * does not know the planet geometry must never boost (the server tick
   * and the client predictor both pass it; AI ships never do).
   */
  cruiseAllowed?: boolean;
  /**
   * The solid surface disc of a landable AIRLESS planet (TASK-87, via
   * shared/galaxy `surfaceDiscAt`): a 'space' ship INSIDE this disc collides
   * with the planet's surface (no tunnel-through) and, having no atmosphere
   * to provide drag, is slowed by {@link SURFACE_FRICTION} until it stops —
   * where the regime machine resolves 'surface'. Defaults to none (a caller
   * that does not know the planet geometry never clamps a space ship).
   */
  surfaceDisc?: SurfaceDisc;
}

/** Cruise (TASK-85) top-speed multiplier (class maxVelocity × this). */
export const CRUISE_SPEED_FACTOR = 4;
/** Cruise (TASK-85) acceleration multiplier (class acceleration × this). */
export const CRUISE_ACCEL_FACTOR = 2;

/** Gravity in the atmosphere regime (u/s²). */
export const GRAVITY = 9.8;
/**
 * VTOL lift at input.up = 1 (u/s²). 1.35 × GRAVITY (TASK-86): full VTOL
 * demand gives a net +0.35·g climb, so a pad-docked ship can take off on
 * the VTOL key ALONE — the pre-TASK-86 value was exactly GRAVITY (neutral
 * buoyancy), which made a pad dock inescapable: lift cancelled gravity, so
 * no input could raise |vel.y| past the pad release threshold and the pad
 * machine re-docked the ship every tick. The climb is drag-limited
 * (terminal v = √(0.35·g / (k·f))), and hover is no longer the rest point
 * (a partial demand up = 1/1.35 ≈ 0.74 would hover; the key is 0/1, so
 * full VTOL climbs).
 */
export const VTOL_LIFT = 1.35 * GRAVITY;
/** Max horizontal speed (u/s) at which VTOL lift still applies. */
export const VTOL_HORIZONAL_LIMIT = 5;
/**
 * Per-step decay of the speed excess above maxVelocity (soft cap, TASK-81).
 * The rule: THRUST can never push the ship past maxVelocity (it may only
 * redirect velocity at top speed); an excess that comes from elsewhere
 * (gravity in a dive, a collision, a server correction) decays this factor
 * per tick — 5 % of the excess bled off each step.
 */
export const SOFT_CAP_DECAY = 0.95;
/** Substep when |vel|·dt exceeds this travel (u) to avoid ground tunneling. */
export const SUBSTEP_MAX_TRAVEL_M = 2;
/**
 * Ground friction (1/s) for a ship grounded on an AIRLESS surface (TASK-87):
 * an airless body has no atmosphere, so no drag — the surface is the ONLY
 * thing that can stop a fast approach. While the ship rests on the terrain
 * its horizontal velocity decays (v *= (1 − FRICTION·h) per substep).
 * FRICTION must DOMINATE full thrust: under sustained thrust the velocity
 * asymptotes to acceleration/FRICTION, so FRICTION > acceleration/5 (10 >
 * 40/5) is what brings a ship that keeps holding W below the regime
 * machine's 5 u/s surface threshold and lands it. The cost is a hard
 * grind-stop (a 120 u/s approach stops in ~15 m, ~100 g) — documented
 * v1 arcade behaviour for the airless surface; atmospheric bodies keep
 * drag as their stop, so this only applies when there is NO planet atmosphere.
 */
export const SURFACE_FRICTION = 10.0;
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
  const surfaceDisc = options?.surfaceDisc;
  const k = dragCoefficient(planet, cls);

  // boost is a 0..1 demand (SHIFT on or off) — clamp, never negate.
  const boost = Math.min(1, Math.max(0, input.boost ?? 0));
  const clamped: ShipInput = {
    thrust: clampUnit(input.thrust),
    yaw: clampUnit(input.yaw),
    pitch: clampUnit(input.pitch),
    roll: clampUnit(input.roll),
    up: clampUnit(input.up),
    boost,
  };

  // TASK-85: cruise engages ONLY in open space with a positive boost demand
  // AND caller-allowed clearance (shared/regime `cruiseAllowedAt`). The
  // EFFECTIVE max/acceleration replace the class values for the whole tick:
  // the TASK-81 thrust clamp, the thrust add and the per-tick soft cap all
  // use it, so after release the excess above the NORMAL max bleeds off at
  // SOFT_CAP_DECAY exactly as before. With boost 0 / not allowed every
  // number is bit-identical to the pre-TASK-85 path.
  const cruising = regime === 'space' && boost > 0 && options?.cruiseAllowed === true;
  const maxVelocity = cruising ? cls.maxVelocity * CRUISE_SPEED_FACTOR : cls.maxVelocity;
  const acceleration = cruising ? cls.acceleration * CRUISE_ACCEL_FACTOR : cls.acceleration;

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
    s = integrateStep(
      s,
      clamped,
      h,
      regime,
      k,
      planet,
      cls,
      heightAt,
      maxVelocity,
      acceleration,
      surfaceDisc,
    );
  }

  // Soft speed cap (once per tick, independent of substepping): the excess
  // above the EFFECTIVE maxVelocity decays SOFT_CAP_DECAY per step.
  const speed = vecLength(s.vel);
  if (speed > maxVelocity) {
    const over = speed - maxVelocity;
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
  planet: PlanetAtmo | undefined,
  cls: ShipClass,
  heightAt: (x: number, z: number) => number,
  maxVelocity: number,
  acceleration: number,
  surfaceDisc: SurfaceDisc | undefined,
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

  // TASK-87: a ship inside a landable airless planet's surface disc is
  // physically ON that planet — the disc is its solid body. Gravity applies
  // there (not only in atmosphere), so a ship the ground clamp lifts onto a
  // ridge falls back into the next dip and stays in ground contact; without
  // it the one-way clamp leaves it skimming over the terrain at full
  // approach speed (an ungrounded ship gets no friction) and it tunnels
  // through the planet.
  const inDisc =
    surfaceDisc !== undefined &&
    (s.pos.x - surfaceDisc.x) * (s.pos.x - surfaceDisc.x) +
      (s.pos.z - surfaceDisc.z) * (s.pos.z - surfaceDisc.z) <=
      surfaceDisc.radius * surfaceDisc.radius;

  if (regime === 'space') {
    // Pure Newtonian: thrust along the forward axis, no drag, no damping.
    // maxVelocity/acceleration are the EFFECTIVE (cruise-adjusted) values
    // resolved once per tick by integrateShip (TASK-85).
    const forward = quatRotateVector(quat, FORWARD);
    const speed0 = vecLength(vel);
    vel = vecAdd(vel, vecScale(forward, input.thrust * acceleration * h));
    // TASK-81: thrust is not a top speed. If the thrust push raised the speed
    // past the EFFECTIVE maxVelocity, rescale to length
    // max(speed0, maxVelocity), keeping the NEW direction (that is what lets
    // a ship steer at top speed). Excess that predates the thrust is left
    // untouched here — the per-tick SOFT_CAP_DECAY in integrateShip bleeds
    // it off.
    const speed1 = vecLength(vel);
    if (speed1 > maxVelocity && speed1 > speed0) {
      vel = vecScale(vecNormalize(vel), Math.max(speed0, maxVelocity));
    }
    // TASK-87: gravity inside the surface disc (see above).
    if (inDisc) vel.y -= GRAVITY * h;
  } else {
    // Application order (TASK-98): drag → forward thrust (+TASK-81 clamp) →
    // gravity → VTOL lift.
    // Quadratic drag opposing velocity, ramped continuously from the
    // atmosphere enter radius (0 in space) down to the surface (1) — the
    // shared boundaryFactor (TASK-28 visuals use the same number).
    const groundY = heightAt(s.pos.x, s.pos.z);
    const factor = planet ? boundaryFactor(s.pos.y - groundY, planet) : 0;
    const speed = vecLength(vel);
    vel = vecAdd(vel, vecScale(vel, -k * factor * speed * h));
    // TASK-98: the main thruster works in the atmosphere/surface regimes too
    // (pre-fix it was dropped here, so on a planet W/S did nothing and the
    // ship was inescapable). The SAME forward-axis push + TASK-81 clamp as
    // the 'space' branch — the shared integrateShip is the one change point
    // for the server tick, the client predictor and the AI.
    const forward = quatRotateVector(quat, FORWARD);
    const speed0 = vecLength(vel);
    vel = vecAdd(vel, vecScale(forward, input.thrust * acceleration * h));
    const speed1 = vecLength(vel);
    if (speed1 > maxVelocity && speed1 > speed0) {
      vel = vecScale(vecNormalize(vel), Math.max(speed0, maxVelocity));
    }
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

  // Ground handling:
  // - 'atmosphere' / 'surface' always clamp to terrain (a landed ship rests
  //   on it; VTOL lift in the 'surface' regime is what gets it back up).
  // - a 'space' ship collides only INSIDE a landable airless planet's surface
  //   disc (TASK-87: that surface is solid — no tunneling through the planet
  //   body).
  // Substepping above keeps travel ≤ 2 u per step, so the clamp can never
  // skip over the surface (no tunneling). On the ground, a ship over an
  // AIRLESS body (no atmosphere → no drag) is slowed by SURFACE_FRICTION —
  // what brings a fast airless approach to rest, where the regime machine
  // resolves 'surface'. inDisc is the (s.pos) test computed before the
  // motion; the ≤ 2 u substep move cannot change the 2 km disc verdict.
  const grounded = regime !== 'space' || inDisc;
  if (grounded) {
    const groundY = heightAt(pos.x, pos.z);
    if (pos.y <= groundY) {
      pos.y = groundY;
      if (vel.y < 0) vel.y = 0;
      if (planet === undefined) {
        const fr = Math.max(0, 1 - SURFACE_FRICTION * h);
        vel.x *= fr;
        vel.z *= fr;
      }
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
