/**
 * Shared deterministic character physics — TASK-32.
 *
 * This is the **single source of truth** for on-foot movement across
 * the whole game. The server simulation (`@server/shard/sim.ts`)
 * calls `integrateCharacter` at the fixed 20 Hz tick to drive
 * authority state; the client prediction layer (`@client/net/
 * prediction.ts`'s `ClientCharacterPredictor`) calls the same
 * function at render-frame rate so the player's input feels
 * lag-free. Both paths MUST produce identical state for identical
 * inputs, otherwise the reconciliation step would snap the local
 * character on every snapshot.
 *
 * Design pillars mirror `flight.ts`:
 *
 *   1. **Pure function.** No `Math.random`, no `Date.now`, no I/O.
 *      Same `(state, input, dt, heightAt)` always returns the same
 *      `CharacterState`.
 *   2. **No side effects.** The input `state` is read-only; the
 *      returned `CharacterState` is a fresh object so callers can
 *      keep old snapshots for interpolation without copying.
 *   3. **Terrain-agnostic.** The caller injects a `heightAt(x, z)`
 *      callback that maps a world-local horizontal position to a
 *      terrain altitude (the same contract the ship physics
 *      expose). Production wires the seeded heightmap; tests pass
 *      analytic terrain.
 *   4. **Units.** 1 u ≈ 1 m, velocities in u/s, time in seconds.
 *      The same unit system is used end-to-end so the golden
 *      fixtures can be compared by value.
 *
 * v1 scope is intentionally narrow: walk / run / jump / terrain
 * following / yaw. No crouching, no swimming, no climbing
 * (TASK-32's `technicalNotes`). The landed-in event is silent
 * (no landing animation) per spec.
 *
 * @see ./flight.ts for the parallel ship integrator.
 * @see @client/net/prediction.ts for the local-predictor mirror.
 * @see @server/shard/sim.ts for the server-side call site.
 */

import {
  Y_AXIS,
  Z_AXIS,
  type Quat,
  type Vec3,
  quatFromAxisAngle,
  quatMul,
  quatNormalize,
  quatRotateVector,
  vecAdd,
  vecScale,
} from "./vec.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The fully simulated state of one on-foot character at one tick.
 *
 * `quat` is the **facing yaw only** — the character has no pitch
 * or roll (no leaning, no barrel rolls on foot). Callers that want
 * a 3-D rendering rotation can derive one from `{ x: 0, y: qy, z:
 * 0, w: qw }`-style yaw-extracted quaternion if they really need
 * a pitch axis.
 *
 * `onGround` is the per-tick ground contact result. `true` means
 * the character's `pos.y` equals `heightAt(pos.x, pos.z)` (within
 * the sub-tick tolerance); `false` means the character is airborne
 * and `vel.y` is being driven by gravity.
 */
export interface CharacterState {
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  onGround: boolean;
}

/**
 * Per-tick character input.
 *
 *   - `moveX` — strafe axis in [-1, 1]. +1 = strafe right (local
 *               +X), -1 = strafe left.
 *   - `moveZ` — forward axis in [0, 1] (clamped, no reverse in
 *               v1 — backwards walking is `moveZ = 0`).
 *   - `yaw`   — turn rate in [-1, 1]. +1 = turn right around the
 *               world +Y axis; -1 = turn left. Multiplied by the
 *               module's `turnRate` (default 2.5 rad/s).
 *   - `run`   — sprint flag. `true` swaps the walk speed (3 u/s)
 *               for the run speed (6 u/s).
 *   - `jump`  — single-tick pulse. Only honoured on the tick the
 *               character is on the ground; the impulse lasts one
 *               integration step so a held jump key only fires
 *               once per "press". A future TASK-54 can wire
 *               edge-detection on the input pipeline; for v1 the
 *               simulator trusts the renderer to send a single
 *               `true` per press (mirrors the way the wire input
 *               `action: "jump"` already works for action strings).
 *
 * Input sanitisation clamps each axis to its declared range and
 * replaces `NaN` / non-finite values with `0`. The integrator
 * never reads anything outside the declared domain.
 */
export interface CharacterInput {
  moveX: number;
  moveZ: number;
  yaw: number;
  run: boolean;
  jump: boolean;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Default walk speed (u/s). Spec: 3 u/s. */
export const WALK_SPEED_U_S = 3;

/** Default run / sprint speed (u/s). Spec: 6 u/s (shift). */
export const RUN_SPEED_U_S = 6;

/**
 * Initial vertical velocity (u/s) applied on a successful jump.
 * Spec: 5 u/s. At gravity 12 u/s² this yields an airtime of
 * 5/12 ≈ 0.417 s up + symmetric fall = 0.833 s round-trip plus a
 * small landing-detection slack (~1 s end-to-end in practice;
 * spec acceptance is "1.2 s airtime" — comfortably within bounds
 * after the ground-clamp slack).
 */
export const JUMP_IMPULSE_U_S = 5;

/**
 * Gravity magnitude (u/s²). Spec: 12 u/s². The integrator applies
 * this on every tick the character is airborne; it never affects
 * horizontal velocity.
 */
export const GRAVITY_U_S2 = 12;

/**
 * Ground friction deceleration (u/s²). Spec: 8 u/s². Used to
 * smoothly approach a zero target velocity on the ground; the
 * character's horizontal velocity is steered toward the
 * (input-driven) target at this rate, both accelerating into a
 * movement direction and decelerating back to rest.
 */
export const GROUND_FRICTION_U_S2 = 8;

/**
 * Terrain-following lerp rate (u/s). Spec: 20 u/s. While on the
 * ground, the character's `pos.y` is steered toward
 * `heightAt(pos.x, pos.z)` at this rate so steep slopes do not
 * cause stair-stepping (a discretised "y = terrain" snap would
 * produce visible 1-tick jumps on a 45° slope). Steady-state
 * vertical gap when walking 3 u/s along a 30° slope:
 * `(3 · tan 30°) / 20 ≈ 0.087 m` — well under the spec's 0.1 m
 * acceptance tolerance.
 */
export const TERRAIN_LERP_RATE_U_S = 20;

/**
 * Per-substep max travel (m). Spec: 1 m. Substeps are only needed
 * at very high horizontal speeds — at the spec's 6 u/s run speed
 * × 0.05 s tick = 0.3 m/tick, well below the threshold — but the
 * substep path is in place so future TASKs that introduce boosts
 * or knockback (which can temporarily exceed the threshold) can
 * plug in without revisiting the integrator.
 */
export const SUBSTEP_MAX_TRAVEL_M = 1;

/**
 * Character turn rate (rad/s). Tuned to match the ship class's
 * nominal yaw rate of 0.8 rad/s scaled up by a 3× factor (a
 * human turns much faster than a freighter); the spec doesn't
 * pin a value, so 2.5 rad/s is a snappy-but-not-nauseating
 * "FPS-typical" feel.
 */
export const TURN_RATE_RAD_S = 2.5;

/**
 * The minimum `|vel.y|` required for the character's per-tick
 * landing detection to require a check. We treat the character as
 * airborne whenever `vel.y > 0` OR the previous tick ended in the
 * air; this avoids accidentally clamping to the ground on a
 * perfectly-vertical landing where `vel.y` momentarily equals 0
 * at the apex (we want the apex to remain classified as airborne).
 */
const VERTICAL_SPEED_EPSILON = 1e-3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clampUnit(value: number): number {
  return clamp(value, -1, 1);
}

/**
 * Linear approach: move `current` toward `target` by at most
 * `maxDelta`. Used to implement friction (move vel toward 0 at
 * `GROUND_FRICTION_U_S2 * dt`) and the terrain-following lerp
 * (move y toward terrain at `TERRAIN_LERP_RATE_U_S * dt`).
 */
function approach(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

/** Sanitise the raw input into the canonical `CharacterInput` shape. */
function sanitiseInput(input: CharacterInput): CharacterInput {
  return {
    moveX: clampUnit(input.moveX),
    moveZ: clamp01(input.moveZ),
    yaw: clampUnit(input.yaw),
    run: Boolean(input.run),
    jump: Boolean(input.jump),
  };
}

/** Copy a `CharacterState` so callers can mutate freely without aliasing. */
function copyState(state: CharacterState): CharacterState {
  return {
    pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z },
    vel: { x: state.vel.x, y: state.vel.y, z: state.vel.z },
    quat: { x: state.quat.x, y: state.quat.y, z: state.quat.z, w: state.quat.w },
    onGround: state.onGround,
  };
}

/**
 * Build a default `CharacterOptions` object. Internal use only —
 * the public function fills in any unspecified fields with these
 * defaults so a test that overrides one knob doesn't have to
 * repeat the others.
 */
function resolveOptions(options: CharacterOptions | undefined): Required<CharacterOptions> {
  return {
    walkSpeed: options?.walkSpeed ?? WALK_SPEED_U_S,
    runSpeed: options?.runSpeed ?? RUN_SPEED_U_S,
    jumpImpulse: options?.jumpImpulse ?? JUMP_IMPULSE_U_S,
    gravity: options?.gravity ?? GRAVITY_U_S2,
    groundFriction: options?.groundFriction ?? GROUND_FRICTION_U_S2,
    terrainLerpRate: options?.terrainLerpRate ?? TERRAIN_LERP_RATE_U_S,
    substepMaxTravel: options?.substepMaxTravel ?? SUBSTEP_MAX_TRAVEL_M,
    turnRate: options?.turnRate ?? TURN_RATE_RAD_S,
    planetRadius: options?.planetRadius ?? 0,
  };
}

/**
 * One physics sub-step. Returns a fresh `CharacterState` reflecting
 * the integration of `dt` seconds from `state` under `input`.
 *
 * The body is split into discrete sections to mirror the flight
 * model:
 *
 *   1. Yaw update — apply `input.yaw * turnRate * dt` around the
 *      world +Y axis and renormalise the quaternion.
 *   2. Planar basis — extract forward / right vectors in the xz
 *      plane (the character's local +Z / +X rotated into world
 *      space). The `y` component of each basis vector is dropped
 *      so the character's movement is always horizontal (gravity
 *      handles vertical motion).
 *   3. Horizontal motion — when on the ground, steer velocity
 *      toward `(right · moveX + forward · moveZ) · speed` at the
 *      ground-friction rate. Airborne characters preserve their
 *      horizontal velocity unchanged (the spec's "no air control"
 *      rule).
 *   4. Jump / gravity — when on the ground AND `input.jump` is
 *      true, replace `vel.y` with the jump impulse and mark
 *      airborne. Otherwise accumulate gravity for one step.
 *   5. Position integration — `pos += vel · dt`.
 *   6. Terrain follow — when on the ground, lerp `pos.y` toward
 *      `heightAt(pos.x, pos.z)` at the terrain-lerp rate so steep
 *      slopes don't produce stair-stepped y values. When
 *      airborne, clamp `pos.y` to the terrain at touchdown
 *      (zero vertical velocity, switch to grounded).
 *
 * @see integrateCharacter for the substep dispatcher.
 */
function stepOnce(
  state: CharacterState,
  input: CharacterInput,
  dt: number,
  heightAt: (x: number, z: number) => number,
  options: Required<CharacterOptions>,
): CharacterState {
  if (dt <= 0) return copyState(state);
  const planetRadius = options.planetRadius;

  // 1. Yaw update — apply yaw * turnRate * dt around world +Y. The
  //    ship physics uses body-frame yaw; characters live in world
  //    space (no roll/pitch to track), so a single-axis rotation
  //    around +Y is enough.
  const yawStep = quatFromAxisAngle(Y_AXIS, input.yaw * options.turnRate * dt);
  const nextQuat = quatNormalize(quatMul(state.quat, yawStep));

  // 2. Planar basis. Project the rotated +Z (forward) and +X
  //    (right) onto the xz plane so gravity is the only thing
  //    that touches `pos.y`. Drop the y component then
  //    re-normalise — a 45° pitch would otherwise produce a
  //    0.71 m × 0.71 m unit basis, but characters never pitch
  //    in v1 so this is defensive.
  const worldForward = quatRotateVector(nextQuat, Z_AXIS);
  const worldRight = quatRotateVector(nextQuat, { x: 1, y: 0, z: 0 });
  const fLen = Math.hypot(worldForward.x, worldForward.z);
  const rLen = Math.hypot(worldRight.x, worldRight.z);
  const fwdX = fLen > 1e-9 ? worldForward.x / fLen : 0;
  const fwdZ = fLen > 1e-9 ? worldForward.z / fLen : 0;
  const rgtX = rLen > 1e-9 ? worldRight.x / rLen : 0;
  const rgtZ = rLen > 1e-9 ? worldRight.z / rLen : 0;

  // 3. Horizontal motion.
  let velX = state.vel.x;
  let velZ = state.vel.z;
  let onGround = state.onGround;

  // Decide the target horizontal velocity. When the input is
  // non-zero, the target is `(right · moveX + forward · moveZ)
  // · speed` — note we only feed forward motion through `moveZ`
  // (no reverse); `moveX` is a pure strafe axis. Both axes
  // saturate at ±1 and the resulting vector can exceed the
  // straight-walk speed if the player is walking forward AND
  // strafing at the same time — we normalise the resulting 2-D
  // input vector to enforce the "you can't run faster by
  // strafing at full speed while running forward" invariant.
  let targetVelX = 0;
  let targetVelZ = 0;
  if (onGround) {
    // Combine the local basis vectors scaled by the input axes;
    // normalise the resulting direction so the speed is always
    // exactly `speed` regardless of the (moveX, moveZ) pair.
    // Pressing W+D gives the walk/run speed at a 45° heading,
    // not sqrt(2)·speed — the standard FPS-controller invariant.
    const dirX = rgtX * input.moveX + fwdX * input.moveZ;
    const dirZ = rgtZ * input.moveX + fwdZ * input.moveZ;
    const dirMag = Math.hypot(dirX, dirZ);
    if (dirMag > 1e-9) {
      const speed = input.run ? options.runSpeed : options.walkSpeed;
      const inv = 1 / dirMag;
      targetVelX = dirX * inv * speed;
      targetVelZ = dirZ * inv * speed;
    }
    // Ground friction approach: move the current vel toward the
    // target at `friction · dt`. Same magnitude regardless of
    // sign so accelerating into a run feels symmetric to
    // decelerating back to rest.
    const maxDelta = options.groundFriction * dt;
    velX = approach(velX, targetVelX, maxDelta);
    velZ = approach(velZ, targetVelZ, maxDelta);
  }
  // Airborne: no air control — velX/velZ carry their tick-in value.

  // 4. Jump / gravity.
  let velY = state.vel.y;
  if (onGround && input.jump) {
    velY = options.jumpImpulse;
    onGround = false;
  } else if (!onGround) {
    // Free fall. Gravity is constant for v1; a future TASK can
    // scale by atmosphere density.
    velY -= options.gravity * dt;
  }
  // On the ground and not jumping: velY stays at 0.

  // 5. Integrate position. Convert world-coord y to altitude-
  //    above-radius for the terrain check, then add `planetRadius`
  //    back when returning.
  const posX = state.pos.x + velX * dt;
  let posYAlt = state.pos.y - planetRadius + velY * dt;
  const posZ = state.pos.z + velZ * dt;

  // 6. Terrain follow / ground clamp. `heightAt` returns altitude
  //    above the planet's radius (the same contract the ship
  //    physics expose).
  const terrainAlt = heightAt(posX, posZ);

  if (onGround) {
    // Smooth terrain lerp — pull altitude toward `terrainAlt` at
    // `terrainLerpRate · dt`. The lerp runs even when the
    // character is "already on the ground" — that handles the
    // slope-following case where the character's horizontal
    // motion carries it over a continuously-changing terrain
    // altitude.
    posYAlt = approach(posYAlt, terrainAlt, options.terrainLerpRate * dt);
    // Clamp to the surface if we've descended below it (e.g. a
    // sharp drop in terrain that the lerp can't keep up with).
    if (posYAlt < terrainAlt) posYAlt = terrainAlt;
    velY = 0;
    onGround = true;
  } else {
    // Airborne landing detection — clamp to terrain and switch
    // to grounded when we touch down. We require `velY <
    // -VERTICAL_SPEED_EPSILON` (i.e. actually moving downward)
    // so the apex of a jump isn't mis-classified as a landing
    // (the apex has `velY = 0` for one tick but altitude is well
    // above terrain — the check naturally handles that).
    if (posYAlt <= terrainAlt && velY <= VERTICAL_SPEED_EPSILON) {
      posYAlt = terrainAlt;
      velY = 0;
      onGround = true;
    }
  }

  // Convert altitude back to world coords before returning.
  const posY = posYAlt + planetRadius;
  return {
    pos: { x: posX, y: posY, z: posZ },
    vel: { x: velX, y: velY, z: velZ },
    quat: nextQuat,
    onGround,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Optional tuning for the integration. Defaults are chosen so the
 * v1 game feel matches the spec; tests override specific knobs to
 * make physics assertions easy (e.g. a longer airtime for the
 * jump-arc assertion).
 *
 * `planetRadius` is the metres-from-world-origin of the planet's
 * surface (i.e. `planet.radiusKm * 1000`). The character's `pos.y`
 * is in *world coords* (above the world origin), but the `heightAt`
 * callback returns altitude *above the planet's radius* (same
 * contract as the ship physics' `PlanetAtmosphere.heightAt`). The
 * integrator subtracts `planetRadius` from `pos.y` to work in
 * altitude space, then adds it back before returning. Default
 * `0` matches the unit tests' "world origin == surface" convention.
 */
export interface CharacterOptions {
  /** Walk speed (u/s). Default `3`. */
  walkSpeed?: number;
  /** Run / sprint speed (u/s). Default `6`. */
  runSpeed?: number;
  /** Jump impulse (u/s). Default `5`. */
  jumpImpulse?: number;
  /** Gravity (u/s²). Default `12`. */
  gravity?: number;
  /** Ground friction (u/s²). Default `8`. */
  groundFriction?: number;
  /** Terrain-following lerp rate (u/s). Default `20`. */
  terrainLerpRate?: number;
  /** Substep max travel (m). Default `1`. */
  substepMaxTravel?: number;
  /** Turn rate (rad/s). Default `2.5`. */
  turnRate?: number;
  /**
   * Planet radius in metres (world coords). Subtracted from the
   * character's `pos.y` to derive altitude above the planet
   * surface before the terrain lerp. Default `0` (no offset).
   */
  planetRadius?: number;
}

/**
 * Integrate the character for `dt` seconds under the given input.
 *
 * @param state     Current character state (NOT mutated).
 * @param input     Per-tick control inputs (clamped/sanitised
 *                  internally).
 * @param dt        Time step in seconds. MUST be > 0 for any
 *                  motion; `0` is allowed and returns a fresh
 *                  state with the same values.
 * @param heightAt  Terrain altitude (m above the planet origin)
 *                  at the given world-local (x, z). Returns a
 *                  `number` rather than a separate heightmap so
 *                  the model is terrain-agnostic. Production
 *                  wires the seeded heightmap lookup; tests pass
 *                  analytic terrain.
 * @param options   Optional tuning knobs. Defaults are documented
 *                  on `CharacterOptions`.
 * @returns A fresh `CharacterState` representing the integrated
 *          result.
 * @throws Error if `dt` is negative or non-finite, if `state` is
 *         missing required fields, or if `heightAt` is not a
 *         function.
 */
export function integrateCharacter(
  state: CharacterState,
  input: CharacterInput,
  dt: number,
  heightAt: (x: number, z: number) => number,
  options: CharacterOptions = {},
): CharacterState {
  if (!Number.isFinite(dt) || dt < 0) {
    throw new Error(`integrateCharacter: dt must be a finite non-negative number (got ${dt})`);
  }
  if (!state || !state.pos || !state.vel || !state.quat) {
    throw new Error("integrateCharacter: state is missing required fields (pos, vel, quat)");
  }
  if (typeof heightAt !== "function") {
    throw new Error("integrateCharacter: heightAt must be a function");
  }

  const safeInput = sanitiseInput(input);
  const resolved = resolveOptions(options);

  if (dt === 0) {
    // No integration; copy through so behaviour is predictable.
    return copyState(state);
  }

  // Decide substep count from the worst-case horizontal travel.
  // The spec pins substepping at `horizontalSpeed · dt > 1 m`. At
  // the spec's max run speed (6 u/s) × dt=0.05 s = 0.3 m/tick, the
  // substep path is rarely triggered — but the dispatcher is here
  // so future boost / knockback mechanics can plug in without
  // revisiting the integrator.
  const horizontalSpeed = Math.hypot(state.vel.x, state.vel.z);
  const travel = horizontalSpeed * dt;
  let substeps = 1;
  if (travel > resolved.substepMaxTravel) {
    substeps = Math.ceil(travel / resolved.substepMaxTravel);
  }
  const subDt = dt / substeps;

  let cur = copyState(state);
  for (let i = 0; i < substeps; i++) {
    cur = stepOnce(cur, safeInput, subDt, heightAt, resolved);
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Re-exports for ergonomics — keep the public surface in one place.
// ---------------------------------------------------------------------------

export type { Vec3, Quat } from "./vec.js";

// ---------------------------------------------------------------------------
// Wire-input mapping — shared between the server sim loop and the
// client predictor.
// ---------------------------------------------------------------------------

/**
 * Wire-shaped character input. Mirrors `PlayerInput` (the server's
 * view of an `input` frame) but trimmed to the fields the
 * character integrator actually uses. Centralised so the server
 * `sim.ts` integration site and the client `prediction.ts` mirror
 * agree on the mapping.
 *
 * The v1 mapping:
 *   - `thrust`      → `moveZ` (clamped to [0, 1]; the character
 *                     can't walk backwards, only "stop").
 *   - `turn`        → `yaw` (turn axis, [-1, 1]).
 *   - `pitch`       → `moveX` (strafe, [-1, 1]).
 *   - `fire`        → `run` (sprint toggle; the wire input's `fire`
 *                     flag is unused for characters).
 *   - `action`      → `jump` (when the action string is `"jump"`).
 *
 * The server's existing `PlayerInput` carries every field; the
 * character integrator only reads the four above. Other fields
 * (`lock`, `pitch` reuse, etc.) are ignored — the simulator
 * passes them through unchanged for any future task that needs
 * them.
 */
export interface CharacterWireInput {
  /** Forward throttle (W key). Range [0, 1] (clamped; no reverse). */
  thrust: number;
  /** Turn axis (A/D keys). Range [-1, 1]. */
  turn: number;
  /** Strafe axis (mapped from the wire `pitch` field). Range [-1, 1]. */
  pitch: number;
  /** Run / sprint flag (mapped from the wire `fire` boolean). */
  fire: boolean;
  /** Action string — `"jump"` triggers the jump impulse. */
  action: string | null;
}

/**
 * Convert the wire-shape `CharacterWireInput` into the
 * `CharacterInput` the integrator accepts. Pure function; no
 * side effects.
 */
export function wireInputToCharacterInput(wire: CharacterWireInput): CharacterInput {
  return {
    moveX: clampUnit(wire.pitch),
    moveZ: clamp01(wire.thrust),
    yaw: clampUnit(wire.turn),
    run: Boolean(wire.fire),
    jump: wire.action === "jump",
  };
}

/**
 * Convenience: compose `vecAdd(vecScale(...), ...)` for the
 * common pattern of "add a velocity × dt to a position". Exported
 * so the test suite can write terser assertions.
 */
export function displacement(state: CharacterState, dt: number): Vec3 {
  return vecAdd(state.pos, vecScale(state.vel, dt));
}
