/**
 * Shared deterministic ship physics.
 *
 * This is the **single source of truth** for ship motion across the
 * whole game. The server simulation (TASK-13+) calls `integrateShip`
 * at a fixed 20 Hz tick to drive authority state; the client
 * prediction layer (TASK-14) calls the same function at the render
 * frame rate so local input feels lag-free. Both paths MUST produce
 * bit-identical state for identical inputs, otherwise the
 * reconciliation step would snap the local ship on every snapshot.
 *
 * Design pillars:
 *
 *   1. **Pure function.** No `Math.random`, no `Date.now`, no I/O, no
 *      module-level mutable state. Same `(state, input, dt, regime,
 *      shipClass, planet?)` always returns the same `ShipState`.
 *   2. **No side effects.** The input `state` is read-only; the
 *      returned `ShipState` is a fresh object so callers can keep
 *      old snapshots for interpolation without copying.
 *   3. **Three regimes.** Space, atmosphere, surface. Each has its own
 *      physics branch; `regime` selects which. The function throws on
 *      an unknown regime so the upstream state machine (TASK-25) fails
 *      loudly instead of silently applying the wrong physics.
 *   4. **Planet-agnostic.** The caller injects a `PlanetAtmosphere`
 *      that owns the `heightAt(x, z)` callback and the drag
 *      parameters. Production wires the seeded heightmap; tests pass
 *      analytic terrain.
 *   5. **Units.** 1 u ≈ 1 m, velocities in u/s, time in seconds. The
 *      same unit system is used end-to-end so the golden fixtures can
 *      be compared by value.
 *
 * The module ships three submodules consumed by `integrateShip`:
 *
 *   - `./vec.ts` — `Vec3` / `Quat` math.
 *   - `./atmosphere.ts` — boundary factor shared with TASK-28.
 *
 * @see TASK-22 for the full acceptance criteria.
 * @see TASK-13 for the server tick that drives `integrateShip`.
 * @see TASK-14 for the client prediction layer that calls the same
 *      function with render-frame `dt` for local input feel.
 * @see TASK-28 for the visual entry/exit transition that consumes
 *      `boundaryFactor`.
 */

import { SHIP_CLASSES, type ShipClass, type ShipClassId } from "../ships.js";
import { altitudeFromPlanet, dragCoefficient, type PlanetAtmosphere } from "./atmosphere.js";
import type { FlightPad } from "./types.js";
import {
  X_AXIS,
  Y_AXIS,
  Z_AXIS,
  type Quat,
  type Vec3,
  quatFromAxisAngle,
  quatMul,
  quatNormalize,
  quatRotateVector,
  vecAdd,
  vecLength,
  vecScale,
} from "./vec.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The three flight regimes the state machine can hand us. The string
 * values are stable wire identifiers — `entity_update` snapshots
 * include them verbatim (TASK-13).
 */
export type FlightRegime = "space" | "atmosphere" | "surface";

/**
 * The fully simulated state of one ship at one tick.
 *
 * `regime` is the value the integration used; if the caller wants to
 * roll a state-machine transition (TASK-25) it should read the
 * returned `regime` and then run its own transition rules *after* the
 * physics step.
 *
 * `onPad` is set when the simulation decides the ship is parked on a
 * landing pad (within pad radius, on the ground, near-zero vertical
 * velocity). The docking UI and the character-egress flow
 * (TASK-29 / TASK-31) consume this field directly.
 */
export interface ShipState {
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  regime: FlightRegime;
  /** Pad id when landed; `undefined` otherwise. */
  onPad?: string;
}

/**
 * Per-tick ship input. All axes are continuous in `[-1, 1]` (except
 * `thrust` and `up` which are `[0, 1]` for throttle-style controls).
 *
 * The control mapping:
 *
 *   - `thrust`  — forward throttle along the ship's local +Z (nose).
 *   - `yaw`     — turn left/right (around world Y; body-frame yaw
 *                 feels like a rudder pedal).
 *   - `pitch`   — nose up/down (around body X axis).
 *   - `roll`    — barrel roll (around body Z axis).
 *   - `up`      — VTOL lift (along world +Y). Only meaningful in
 *                 atmosphere / surface regime; ignored in space.
 *
 * Negative `thrust` is clamped to 0 (no reverse thrusters in v1).
 * `yaw` / `pitch` / `roll` are clamped to `[-1, 1]`.
 */
export interface ShipInput {
  thrust: number;
  yaw: number;
  pitch: number;
  roll: number;
  up: number;
}

// (FlightPad is defined in ./types.ts to avoid a circular import with
// ./atmosphere.ts — both flight.ts and atmosphere.ts need to reference it
// but neither depends on the other.)

/**
 * Optional tuning for the integration. Defaults are chosen so the
 * v1 game feel is right; tests override `vtolThrust` and
 * `dragArea` to make physics assertions easy.
 */
export interface FlightOptions {
  /** VTOL thrust in u/s² per unit of `input.up`. Default `25`. */
  vtolThrust?: number;
  /**
   * Cross-sectional drag area in m² used by the atmosphere drag
   * formula. Default `1`. See `dragCoefficient` for the full
   * `k = atmoDensity * (mass / area) * boundaryFactor` derivation.
   */
  dragArea?: number;
  /**
   * Per-step decay rate for the soft speed cap above `maxVelocity`.
   * `0.05` means each tick decays 5% of the excess over `maxVelocity`.
   * Default `0.05`.
   */
  softCapDecay?: number;
  /**
   * Maximum per-tick travel (in metres) before the integration
   * substeps. Prevents ground-tunneling when a ship falls fast.
   * Default `2`.
   */
  substepMaxTravel?: number;
  /**
   * Pad detection radius (metres). The default uses each pad's own
   * `radius`. The flight model only needs the *largest* such radius
   * to clamp landing detection.
   */
  padRadius?: number;
}

// ---------------------------------------------------------------------------
// Tunable defaults
// ---------------------------------------------------------------------------

const DEFAULT_VTOL_THRUST = 25;
const DEFAULT_DRAG_AREA = 1;
const DEFAULT_SOFT_CAP_DECAY = 0.05;
const DEFAULT_SUBSTEP_MAX_TRAVEL = 2;
const DEFAULT_PAD_RADIUS = 20;
/** Maximum vertical speed (m/s) to count as "stationary" for pad detection. */
const PAD_VERTICAL_SPEED_THRESHOLD = 2;
/** Horizontal-speed threshold (m/s) below which VTOL lift can engage. */
const VTOL_HORIZONTAL_SPEED_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** Clamp + sanitise the raw input into the canonical `ShipInput` shape. */
function sanitiseInput(input: ShipInput): ShipInput {
  return {
    thrust: clamp(Number.isFinite(input.thrust) ? input.thrust : 0, 0, 1),
    yaw: clamp(Number.isFinite(input.yaw) ? input.yaw : 0, -1, 1),
    pitch: clamp(Number.isFinite(input.pitch) ? input.pitch : 0, -1, 1),
    roll: clamp(Number.isFinite(input.roll) ? input.roll : 0, -1, 1),
    up: clamp(Number.isFinite(input.up) ? input.up : 0, 0, 1),
  };
}

function copyState(state: ShipState): ShipState {
  return {
    pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z },
    vel: { x: state.vel.x, y: state.vel.y, z: state.vel.z },
    quat: { x: state.quat.x, y: state.quat.y, z: state.quat.z, w: state.quat.w },
    regime: state.regime,
    onPad: state.onPad,
  };
}

/**
 * Soft speed-cap: if `|vel| > maxVelocity`, decay the excess by
 * `decay` per step. The cap is "soft" because we keep applying
 * thrust — the extra thrust *can* keep pushing `|vel|` above the cap
 * by a tiny steady-state amount equal to
 * `thrust / (mass * 2 * |vel|) / decay`. With the default
 * `decay = 0.05` the steady-state overshoot is well below 1% for any
 * sane thrust value, so players feel the cap as a hard wall without
 * a numerical pop.
 */
function applySoftSpeedCap(vel: Vec3, maxVelocity: number, decay: number): Vec3 {
  const speed = vecLength(vel);
  if (speed <= maxVelocity || speed < 1e-9) return vel;
  const excess = speed - maxVelocity;
  const newExcess = excess * (1 - decay);
  const scale = (maxVelocity + newExcess) / speed;
  return vecScale(vel, scale);
}

/**
 * Pick the nearest pad under the ship. Returns `undefined` if no pad
 * is within `radius`. `pos` is in world coords; pad centres are
 * converted to world coords via `planet.radius`.
 */
function findNearestPad(
  pos: Vec3,
  pads: readonly FlightPad[] | undefined,
  planetRadius: number,
  radius: number,
): FlightPad | undefined {
  if (!pads || pads.length === 0) return undefined;
  let best: FlightPad | undefined;
  let bestDistSq = radius * radius;
  for (const pad of pads) {
    const dx = pos.x - pad.x;
    const dz = pos.z - pad.z;
    const dy = pos.y - (planetRadius + pad.height);
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      best = pad;
    }
  }
  return best;
}

/**
 * One physics sub-step. Returns a fresh `ShipState` reflecting the
 * integration of `dt` seconds from `state` under `input`.
 */
function stepOnce(
  state: ShipState,
  input: ShipInput,
  dt: number,
  regime: FlightRegime,
  shipClass: ShipClass,
  planet: PlanetAtmosphere | undefined,
  options: Required<FlightOptions>,
): ShipState {
  if (dt <= 0) return copyState(state);

  // 1. Rotation: apply yaw/pitch/roll in the body frame (right-multiply).
  // World-space axes keep the math simple; the resulting quaternion is
  // renormalised to avoid drift accumulation over many ticks.
  const turnScale = shipClass.turnRate * dt;
  const dRotYaw = quatFromAxisAngle(Y_AXIS, input.yaw * turnScale);
  const dRotPitch = quatFromAxisAngle(X_AXIS, input.pitch * turnScale);
  const dRotRoll = quatFromAxisAngle(Z_AXIS, input.roll * turnScale);
  const dRot = quatMul(quatMul(dRotYaw, dRotPitch), dRotRoll);
  const nextQuat = quatNormalize(quatMul(state.quat, dRot));

  // 2. Forward axis (local +Z rotated into world frame).
  const forward = quatRotateVector(nextQuat, Z_AXIS);

  // 3. Thrust acceleration in world frame.
  const thrustAccel = input.thrust * shipClass.acceleration;
  const thrustVec = vecScale(forward, thrustAccel);

  // 4. Drag (atmosphere regime only).
  let dragVec = { x: 0, y: 0, z: 0 };
  if (regime === "atmosphere" && planet) {
    const altitude = altitudeFromPlanet(state.pos, planet);
    const k = dragCoefficient(altitude, planet, shipClass.mass, options.dragArea);
    if (k > 0) {
      const speed = vecLength(state.vel);
      if (speed > 1e-9) {
        // Quadratic drag: a_drag = -k * |v| * v (per spec).
        // Magnitude = k * |v|²; direction = -v_hat.
        // Equivalent: a_drag = -k * |v| * vel (since |v| > 0).
        const scale = -k * speed;
        dragVec = vecScale(state.vel, scale);
      }
    }
  }

  // 5. VTOL lift (atmosphere / surface regime only).
  let liftVec = { x: 0, y: 0, z: 0 };
  if ((regime === "atmosphere" || regime === "surface") && input.up > 0) {
    // Only engage when horizontal speed is small (per spec: < 5 u/s).
    const horizontalSpeedSq = state.vel.x * state.vel.x + state.vel.z * state.vel.z;
    if (horizontalSpeedSq < VTOL_HORIZONTAL_SPEED_THRESHOLD * VTOL_HORIZONTAL_SPEED_THRESHOLD) {
      liftVec = { x: 0, y: input.up * options.vtolThrust, z: 0 };
    }
  }

  // 6. Integrate velocity.
  const accel = vecAdd(vecAdd(thrustVec, dragVec), liftVec);
  const dv = vecScale(accel, dt);
  const velAfterAccel = vecAdd(state.vel, dv);

  // 7. Soft speed cap (applies in all regimes; the cap decays excess
  //    so the player's "stuck against the wall" feel is preserved).
  const nextVel = applySoftSpeedCap(velAfterAccel, shipClass.maxVelocity, options.softCapDecay);

  // 8. Integrate position.
  const dp = vecScale(nextVel, dt);
  let nextPos = vecAdd(state.pos, dp);

  // 9. Ground collision (atmosphere / surface regime).
  let nextOnPad: string | undefined = state.onPad;
  if (regime === "atmosphere" || regime === "surface") {
    if (planet) {
      const terrainY = planet.radius + planet.heightAt(nextPos.x, nextPos.z);
      if (nextPos.y <= terrainY) {
        nextPos = { x: nextPos.x, y: terrainY, z: nextPos.z };
        // After clamping, vertical velocity is zero.
        const wasMovingVertically = Math.abs(state.vel.y) > PAD_VERTICAL_SPEED_THRESHOLD;
        const clampedVel = { ...nextVel, y: 0 };
        // Pad detection: within the largest pad radius AND with
        // small enough vertical speed to count as "landed".
        const nearest = findNearestPad(nextPos, planet.pads, planet.radius, options.padRadius);
        const canLand = nearest !== undefined && Math.abs(nextVel.y) < PAD_VERTICAL_SPEED_THRESHOLD;
        if (canLand) {
          nextOnPad = nearest.id;
        } else if (wasMovingVertically) {
          // Crashed into the ground but not on a pad → leave onPad as is
          // (a ship already on a pad that lifts off keeps onPad until it
          // moves vertically above the threshold; the state machine
          // will clear it).
          nextOnPad = state.onPad;
        } else {
          nextOnPad = state.onPad;
        }
        return {
          pos: nextPos,
          vel: clampedVel,
          quat: nextQuat,
          regime,
          onPad: nextOnPad,
        };
      } else {
        // Above ground: take off clears onPad when vertical speed > threshold.
        if (state.onPad !== undefined && Math.abs(nextVel.y) > PAD_VERTICAL_SPEED_THRESHOLD) {
          nextOnPad = undefined;
        }
      }
    }
  }

  return {
    pos: nextPos,
    vel: nextVel,
    quat: nextQuat,
    regime,
    onPad: nextOnPad,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Integrate the ship for `dt` seconds under the given input.
 *
 * @param state     Current ship state (NOT mutated).
 * @param input     Per-tick control inputs (clamped/sanitised internally).
 * @param dt        Time step in seconds. MUST be > 0 for any motion.
 * @param regime    Which physics branch to apply. The returned state
 *                  carries the same regime; transitions are the
 *                  state-machine's job (TASK-25).
 * @param shipClass Ship class (mass / accel / maxVelocity / turnRate).
 *                  Pass a value from `SHIP_CLASSES`.
 * @param planet    Atmosphere + heightmap + pads context. Required for
 *                  `atmosphere` and `surface` regimes; ignored for
 *                  `space`.
 * @param options   Optional tuning knobs. Defaults are documented on
 *                  `FlightOptions`.
 * @returns A fresh `ShipState` representing the integrated result.
 * @throws Error if `regime` is not one of `"space" | "atmosphere" | "surface"`.
 */
export function integrateShip(
  state: ShipState,
  input: ShipInput,
  dt: number,
  regime: FlightRegime,
  shipClass: ShipClass,
  planet?: PlanetAtmosphere,
  options: FlightOptions = {},
): ShipState {
  if (!Number.isFinite(dt) || dt < 0) {
    throw new Error(`integrateShip: dt must be a finite non-negative number (got ${dt})`);
  }
  if (!state || !state.pos || !state.vel || !state.quat) {
    throw new Error("integrateShip: state is missing required fields (pos, vel, quat)");
  }
  if (!shipClass || typeof shipClass.mass !== "number") {
    throw new Error("integrateShip: shipClass is missing or malformed");
  }

  if (regime !== "space" && regime !== "atmosphere" && regime !== "surface") {
    throw new Error(`integrateShip: unknown regime "${String(regime)}"`);
  }

  // Atmosphere / surface regimes REQUIRE a planet (heightAt + drag).
  if ((regime === "atmosphere" || regime === "surface") && !planet) {
    throw new Error(
      `integrateShip: planet is required for regime "${regime}" (provides heightAt + drag)`,
    );
  }

  const resolved: Required<FlightOptions> = {
    vtolThrust: options.vtolThrust ?? DEFAULT_VTOL_THRUST,
    dragArea: options.dragArea ?? DEFAULT_DRAG_AREA,
    softCapDecay: options.softCapDecay ?? DEFAULT_SOFT_CAP_DECAY,
    substepMaxTravel: options.substepMaxTravel ?? DEFAULT_SUBSTEP_MAX_TRAVEL,
    padRadius: options.padRadius ?? DEFAULT_PAD_RADIUS,
  };

  const safeInput = sanitiseInput(input);

  if (dt === 0) {
    // No integration; return a fresh state with the new orientation
    // already applied (rotations are instant — but with dt=0 nothing
    // moves; copy through to keep behaviour predictable).
    return {
      pos: { ...state.pos },
      vel: { ...state.vel },
      quat: { ...state.quat },
      regime,
      onPad: state.onPad,
    };
  }

  // Decide substep count from the worst-case per-tick travel.
  const speed = vecLength(state.vel);
  const travel = speed * dt;
  let substeps = 1;
  if (travel > resolved.substepMaxTravel) {
    substeps = Math.ceil(travel / resolved.substepMaxTravel);
  }
  const subDt = dt / substeps;

  let cur = copyState(state);
  for (let i = 0; i < substeps; i++) {
    cur = stepOnce(cur, safeInput, subDt, regime, shipClass, planet, resolved);
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Re-exports for ergonomics
// ---------------------------------------------------------------------------

export {
  BOUNDARY_RAMP_WIDTH_M,
  boundaryFactor,
  dragCoefficient,
  altitudeFromPlanet,
  makeFlatPlanet,
  type PlanetAtmosphere,
} from "./atmosphere.js";
export type { Vec3, Quat } from "./vec.js";
export type { FlightPad } from "./types.js";
export {
  IDENTITY,
  ZERO,
  X_AXIS,
  Y_AXIS,
  Z_AXIS,
  quatFromAxisAngle,
  quatFromEuler,
  quatMul,
  quatNormalize,
  quatRotateVector,
  quatToMat3,
  vecAdd,
  vecCross,
  vecDot,
  vecEquals,
  vecLength,
  vecLengthSq,
  vecLerp,
  vecNormalize,
  vecScale,
  vecSub,
} from "./vec.js";

/**
 * Convenience: look up a `ShipClass` by id and forward to
 * `integrateShip`. Mostly useful for tests that don't want to type
 * the long signature repeatedly.
 *
 * @throws Error if `classId` is not in `SHIP_CLASSES`.
 */
export function integrateShipByClassId(
  state: ShipState,
  input: ShipInput,
  dt: number,
  regime: FlightRegime,
  classId: ShipClassId,
  planet?: PlanetAtmosphere,
  options?: FlightOptions,
): ShipState {
  const cls = SHIP_CLASSES[classId];
  if (!cls) {
    throw new Error(`integrateShipByClassId: unknown ship class id "${classId}"`);
  }
  return integrateShip(state, input, dt, regime, cls, planet, options);
}
