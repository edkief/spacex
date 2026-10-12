/**
 * Stop autopilot (TASK-109) — the pure "parking brake" controller.
 *
 * The server (the shard tick) calls `stopInput` INSTEAD of the player's
 * mapped frame while the per-player `stopActive` flag is set, so the ship
 * decelerates on its own until it is stopped:
 * - in SPACE the nose is turned onto the velocity vector (at the class
 *   turnRate, via normalized yaw/pitch/roll demands) and the SCALED retro
 *   thrust is applied — the flight model's own `thrust × class acceleration`
 *   does the deceleration, so every class stops with its OWN stats (the
 *   demands are class-independent [-1, 1]; integrateShip scales them);
 * - in the ATMOSPHERE/SURFACE regimes the nose is turned onto the
 *   HORIZONTAL velocity first (the vertical is gravity's — aiming the retro
 *   at the full gravity-bent velocity would push UP against the fall and
 *   flap); once the horizontal speed is under the VTOL gate
 *   (DESCENT_SPEED = 5 u/s) a CONTROLLED DESCENT takes over: the VTOL `up`
 *   demand is a PD lift on the vertical speed targeting a ~10 u/s sink
 *   (bounded by VTOL_LIFT, drag-limited — controlled, not free fall), while
 *   the scaled retro kills the residual horizontal drift;
 * - when already stopped (slow AND in space OR grounded) it returns the
 *   zero-demand input, so a completed stop coasts exactly like an idle ship.
 *
 * CHOSEN MECHANISM (spec step 2b): the "turn toward -velocity, then thrust"
 * approach, implemented as AIM-AT-VELOCITY + (SCALED) FULL RETRO (thrust
 * = -1 pushes along -forward, i.e. along -velocity once aligned). The
 * acceptance bar is the stop TIMING, not the mechanism. Two stability rules
 * keep it deterministic (no limit cycles):
 * 1. TURN PHASE HAS NO THRUST — a retro thrust while the nose is > 10° off
 *    the velocity pushes SIDEWAYS, rotating the velocity direction faster
 *    than the class turnRate can chase it (thrust/speed > turnRate), so the
 *    nose stays exactly 90° behind and the ship circles forever at constant
 *    speed. Pure turning, then full retro once aligned.
 * 2. SCALED RETRO — full thrust removes acceleration·dt of speed per tick;
 *    near the stop that OVERSHOOTS zero, flipping the velocity 180° and
 *    re-aiming (oscillation around STOP_SPEED_EPS). Scaling to exactly the
 *    remaining speed lands at (≈) zero in one tick.
 *
 * The module is PURE and DETERMINISTIC: no Math.random, no clock — `dt` is
 * a parameter (the tick's timestep; consumed by the scaled retro).
 */

import type { ShipClass } from '../ships';
import type { Regime, ShipInput, ShipState } from './flight';
import { GRAVITY, VTOL_LIFT } from './flight';
import {
  quatInverse,
  quatRotateVector,
  vecCross,
  vecDot,
  vecLength,
  vecScale,
  type Quat,
  type Vec3,
} from './vec';

/** |vel| below which a stopped ship counts as stopped (u/s). */
export const STOP_SPEED_EPS = 0.5;
/**
 * HORIZONTAL speed (u/s) below which (atmosphere/surface, above ground) the
 * descent phase starts. Set at the VTOL horizontal gate
 * (VTOL_HORIZONAL_LIMIT = 5): below it the lift demand is always accepted,
 * so the descent controller owns the VERTICAL axis while the scaled retro
 * owns the horizontal one. The gate is on the horizontal speed (not the
 * total speed): a falling ship's vertical velocity must not flip it back
 * into the aim-and-retro phase, whose nose-onto-velocity retro would push
 * UP and flap it forever around the boundary.
 */
const DESCENT_SPEED = 5;
/**
 * Target vertical speed of the controlled descent (u/s, down is negative).
 * -10 (not the spec's sketch of ~2): the 200 m → ground AC demands a
 * < 30 s total, and a 2 u/s sink would take ~90 s for the last 170 m —
 * the timing bar wins over the sketch (the spec names the timing, not the
 * sink rate, as the acceptance criterion). The lift still caps the sink
 * (bounded by VTOL_LIFT, drag-limited), so it is a controlled descent,
 * not free fall.
 */
const DESCENT_RATE = -10;
/** PD gain on the vertical-speed error of the descent lift (1/s). */
const DESCENT_KP = 2;
/** Nose-vs-target angle (rad) below which the ship counts as aligned (retro on). */
const ALIGN_THRESHOLD_RAD = 0.15;
/** Altitude (u) at or below which the ship counts as grounded. */
const GROUND_EPS = 0.05;
/** Horizontal drift (u/s) below which the descent phase stops throttling. */
const HORIZONTAL_EPS = 0.05;

const FORWARD: Vec3 = { x: 0, y: 0, z: 1 };
const ZERO_INPUT: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * The per-tick stop demand for one ship. Pure: same (state, cls, dt,
 * options) → identical ShipInput. All channels are within the flight
 * model's [-1, 1] / [0, 1] contract, so integrateShip needs no changes.
 *
 * @param state   the ship's AUTHORITY kinematic state (the shard's record,
 *                never the client's prediction)
 * @param cls     the ship's own class (deceleration is class-scaled by the
 *                integrator's demand × acceleration / demand × turnRate)
 * @param dt      the tick's timestep (consumed by the scaled retro)
 * @param options the regime + terrain seam (the shard passes the same
 *                heightAt it feeds integrateShip; flat ground if omitted)
 */
export function stopInput(
  state: ShipState,
  cls: ShipClass,
  dt: number,
  options: { regime: Regime; heightAt?: (x: number, z: number) => number },
): ShipInput {
  const groundY = options.heightAt ? options.heightAt(state.pos.x, state.pos.z) : 0;
  const altitude = state.pos.y - groundY;
  const grounded = altitude <= GROUND_EPS;
  const speed = vecLength(state.vel);
  const hSpeed = Math.hypot(state.vel.x, state.vel.z);

  // (d) Already stopped: zero-demand input (a byte-identical idle frame).
  if (speed <= STOP_SPEED_EPS && (options.regime === 'space' || grounded)) {
    return ZERO_INPUT;
  }

  // (c) Controlled descent: horizontally slow + above ground in
  // atmosphere/surface (the vertical axis is the lift's from here on).
  if (options.regime !== 'space' && hSpeed < DESCENT_SPEED && altitude > GROUND_EPS) {
    return descentInput(state, cls, dt);
  }

  // (b) Deceleration: aim the nose at the target direction, then (scaled)
  // retro. SPACE: the full velocity vector (no gravity to fight).
  if (options.regime === 'space' || hSpeed <= HORIZONTAL_EPS) {
    if (speed <= 1e-9) return ZERO_INPUT;
    return decelerate(state, cls, dt, vecScale(state.vel, 1 / speed), speed);
  }

  // ATMOSPHERE/SURFACE, still fast horizontally: aim at the HORIZONTAL
  // velocity only (see the module note on why the full vector flaps).
  const target: Vec3 = { x: state.vel.x / hSpeed, y: 0, z: state.vel.z / hSpeed };
  return decelerate(state, cls, dt, target, hSpeed);
}

/**
 * The controlled-descent demand: VTOL lift as a PD on vertical speed
 * (target: a ~10 u/s sink — the gravity-cancelled rest point is exactly
 * the target, so the ship settles into a steady controlled descent, the
 * lift bounded by VTOL_LIFT) + the aim-and-retro deceleration on the
 * HORIZONTAL drift (the ship is < DESCENT_SPEED in, so the drift is inside
 * the VTOL horizontal gate of 5 u/s).
 */
function descentInput(state: ShipState, cls: ShipClass, dt: number): ShipInput {
  const vel = state.vel;
  const lift = GRAVITY + DESCENT_KP * (DESCENT_RATE - vel.y);
  const up = lift < 0 ? 0 : lift > VTOL_LIFT ? 1 : lift / VTOL_LIFT;
  const hSpeed = Math.hypot(vel.x, vel.z);
  if (hSpeed < HORIZONTAL_EPS) {
    return { thrust: 0, yaw: 0, pitch: 0, roll: 0, up };
  }
  const target: Vec3 = { x: vel.x / hSpeed, y: 0, z: vel.z / hSpeed };
  const decel = decelerate(state, cls, dt, target, hSpeed);
  return { ...decel, up };
}

/**
 * Aim-and-retro for one direction: turn the nose onto `target` at the class
 * turnRate (turn phase, NO thrust — see rule 1), then scaled full retro
 * (rule 2) once aligned. `scaleSpeed` is the speed component the retro
 * must remove (the full speed in space, the horizontal speed on a planet).
 */
function decelerate(
  state: ShipState,
  cls: ShipClass,
  dt: number,
  target: Vec3,
  scaleSpeed: number,
): ShipInput {
  const forward = quatRotateVector(state.quat, FORWARD);
  const axis = vecCross(forward, target);
  const angle = Math.atan2(vecLength(axis), vecDot(forward, target));
  if (angle < ALIGN_THRESHOLD_RAD) {
    return {
      thrust: -scaledRetro(scaleSpeed, cls.acceleration, dt),
      yaw: 0,
      pitch: 0,
      roll: 0,
      up: 0,
    };
  }
  const { yaw, pitch, roll } = aimDemands(state.quat, target);
  return { thrust: 0, yaw, pitch, roll, up: 0 };
}

/**
 * The retro-thrust magnitude for one tick: full thrust would remove
 * acceleration·dt of speed; scaled to remove exactly `speed` so the tick
 * lands at (≈) zero instead of OVERSHOOTING — an overshoot flips the
 * velocity direction 180°, re-aims the nose, and oscillates forever
 * around STOP_SPEED_EPS (deterministic limit cycle, no stop).
 */
function scaledRetro(speed: number, acceleration: number, dt: number): number {
  const full = acceleration * dt;
  return full > 0 ? Math.min(1, speed / full) : 1;
}

/**
 * Normalized per-axis rate demands that rotate the nose toward `target`.
 * The world rotation axis (forward × target, unit) is mapped into the ship's
 * LOCAL frame; the flight model applies demand × turnRate about local
 * Y/X/Z, so a unit local axis turns the nose at the class's FULL turnRate.
 * The antiparallel case (nose exactly 180° off) has no cross-product axis —
 * it falls back to a fixed perpendicular (world +Y, or +X when the nose is
 * vertical) so the turn still starts.
 */
function aimDemands(
  quat: Quat,
  target: Vec3,
): { yaw: number; pitch: number; roll: number } {
  const forward = quatRotateVector(quat, FORWARD);
  let axis = vecCross(forward, target);
  let len = vecLength(axis);
  if (len < 1e-9) {
    axis = Math.abs(forward.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    len = 1;
  }
  const local = quatRotateVector(quatInverse(quat), vecScale(axis, 1 / len));
  return { yaw: clampUnit(local.y), pitch: clampUnit(local.x), roll: clampUnit(local.z) };
}
