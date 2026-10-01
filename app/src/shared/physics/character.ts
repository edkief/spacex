/**
 * Character (on-foot) physics (TASK-31 spawn math + TASK-32 movement) —
 * deterministic, DOM-free, shared VERBATIM by the server sim (authority)
 * and the client prediction (TASK-32 CharacterPredictor, the TASK-14
 * pattern). Same contract as the flight model (./flight): pure function,
 * terrain injected as `heightAt(x, z)`, no Math.random, no side effects.
 *
 * v1 scope (PRD): walk / run / jump / terrain following only. No crouch,
 * no swimming, no climbing — v1 terrain has no water.
 *
 * Model:
 * - walk 3 u/s, run 6 u/s (the speed is set directly while a move key is
 *   held — arcade, no accel phase); with no move input, ground friction
 *   decays the horizontal speed at 8 u/s².
 * - jump: only from the ground (no double jump), impulse 5 u/s. With
 *   gravity 12 u/s² the arc apex is v²/2g ≈ 1.04 m and the airtime is
 *   2v/g ≈ 0.83 s (the task spec's "1.2 s airtime" is inconsistent with
 *   its own pinned apex number — the acceptance criterion's apex 1.04 m
 *   wins, which is exactly 25/24 at v = 5, g = 12).
 * - no air control: horizontal input (move AND turning) is ignored
 *   while airborne.
 * - terrain following: on the ground the feet y is lerped toward
 *   heightAt(x, z) at 20 u/s, so slopes are tracked smoothly (no
 *   stair-stepping at 10 Hz snapshots). The lerp outruns the steepest
 *   seeded slope at any walk/run speed (max slope 45° ⇒ ≤ 6 u/s of
 *   vertical travel), so the character can never sink below the surface.
 * - substepping: whenever horizontal speed · dt > 1 m the step is split
 *   into ≤ 1 m substeps, so a cliff edge / slope kink is resolved at
 *   sub-metre precision and never tunneled.
 *
 * Units: 1 u ≈ 1 m, velocities in u/s, angles in radians.
 */

import {
  quatFromAxisAngle,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatRotateVector,
  vecNormalize,
  type Quat,
  type Vec3,
} from './vec';

// --- TASK-31: disembark spawn math ----------------------------------------

/** Lateral offset from the ship's centerline to the character spawn (m). */
export const CHAR_SHIP_SIDE_OFFSET_M = 2.5;

/** The ship's forward axis is local +Z (the flight model's thrust axis). */
export const SHIP_RIGHT_LOCAL: Vec3 = { x: 1, y: 0, z: 0 };

/**
 * Pure: the disembark spawn position. The ship's world position shifted
 * 2.5 m along its world-right (forward-perpendicular), with y pinned to
 * the pad surface height (the character stands on the pad plane).
 */
export function characterSpawnPos(shipPos: Vec3, shipQuat: Quat, padHeight: number): Vec3 {
  const side = quatRotateVector(shipQuat ?? quatIdentity(), {
    x: CHAR_SHIP_SIDE_OFFSET_M,
    y: 0,
    z: 0,
  });
  return { x: shipPos.x + side.x, y: padHeight, z: shipPos.z + side.z };
}

// --- TASK-32: movement model ------------------------------------------------

/** Walk speed (u/s) with a move key held. */
export const CHAR_WALK_SPEED = 3;
/** Run speed (u/s) with a move key + the run (shift) key held. */
export const CHAR_RUN_SPEED = 6;
/** Jump impulse (u/s), applied only from the ground state. */
export const CHAR_JUMP_VELOCITY = 5;
/** Character gravity in the surface regime (u/s²). */
export const CHAR_GRAVITY = 12;
/** Ground friction: horizontal deceleration (u/s²) with no move input. */
export const CHAR_GROUND_FRICTION = 8;
/** Terrain-follow rate (u/s): the feet y lerps toward the surface at this speed. */
export const CHAR_TERRAIN_LERP_SPEED = 20;
/** Substep when horizontal speed · dt exceeds this travel (m) — no cliff tunneling. */
export const CHAR_SUBSTEP_MAX_TRAVEL_M = 1;
/** Character turn rate (rad/s) while a turn key is held on the ground. */
export const CHAR_TURN_RATE = 3;

/**
 * The surface dropped below the feet by more than this (m) in one substep
 * → the character walked off an edge and becomes airborne. Must stay
 * well below any real ledge drop (v1 ledges are metres high) while the
 * 20 u/s terrain lerp keeps the gap at ~0 on ≤ 45° slopes.
 */
const OFF_GROUND_EPS_M = 0.05;
/** A falling character lands when its feet reach within this (m) of the surface. */
const LANDING_EPS_M = 1e-6;

const Y_AXIS: Vec3 = { x: 0, y: 1, z: 0 };
const FORWARD_LOCAL: Vec3 = { x: 0, y: 0, z: 1 };

/** Per-tick control input for the surface regime. */
export interface CharacterInput {
  forward: boolean;
  back: boolean;
  /** Turn the facing left (−yaw); ground only (no air control). */
  left: boolean;
  /** Turn the facing right (+yaw); ground only (no air control). */
  right: boolean;
  /** Double the move speed (the shift key). */
  run: boolean;
  /** Jump (only while onGround; holding it auto-rejumps on landing — v1). */
  jump: boolean;
}

/** Zero character input (a disconnected / coasting character). */
export const ZERO_CHARACTER_INPUT: CharacterInput = {
  forward: false,
  back: false,
  left: false,
  right: false,
  run: false,
  jump: false,
};

/** Kinematic state of one on-foot character (the sim's authority record). */
export interface CharacterState {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  /** Facing — yaw only (no pitch/roll); local +Z is forward. */
  quat: Quat;
}

/** Standing character at `pos` facing `quat` (yaw-only; defaults to +Z). */
export function restCharacterState(pos: Vec3, quat: Quat = quatIdentity()): CharacterState {
  return {
    pos: { ...pos },
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,
    quat: { ...quat },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function cloneState(s: CharacterState): CharacterState {
  return {
    pos: { ...s.pos },
    vel: { ...s.vel },
    onGround: s.onGround,
    quat: { ...s.quat },
  };
}

/**
 * Integrate one character forward by dt. Pure and deterministic: same
 * (state, input, dt, heightAt) → identical CharacterState. The server
 * ticks at a fixed dt (1/20 s); the client prediction may call with a
 * variable frame dt — both use this exact function so the state streams
 * stay in lock step (TASK-14 pattern).
 *
 * @param state    current kinematic state (never mutated)
 * @param input    control input this tick (booleans, no clamping needed)
 * @param dt       timestep in seconds (must be > 0 and finite)
 * @param heightAt terrain height at (x, z) in u (caller-injected, the
 *                 flight model's contract; defaults to flat y = 0)
 * @returns the new CharacterState (a fresh object — the input is untouched)
 */
export function integrateCharacter(
  state: CharacterState,
  input: CharacterInput,
  dt: number,
  heightAt?: (x: number, z: number) => number,
): CharacterState {
  if (!(dt > 0) || !Number.isFinite(dt)) {
    throw new Error(`dt must be a positive finite number of seconds, got ${dt}`);
  }
  const sample = heightAt ?? (() => 0);

  // Substep so no single step travels more than CHAR_SUBSTEP_MAX_TRAVEL_M
  // horizontally — cliff edges / slope kinks are resolved at sub-metre
  // precision and the terrain clamp can never be skipped (no tunneling).
  const travel = Math.hypot(state.vel.x, state.vel.z) * dt;
  const steps = Math.max(1, Math.ceil(travel / CHAR_SUBSTEP_MAX_TRAVEL_M));
  const h = dt / steps;

  let s = cloneState(state);
  for (let i = 0; i < steps; i++) {
    s = characterSubstep(s, input, h, sample);
  }
  return s;
}

/** One substep of character physics (turning, motion, terrain). */
function characterSubstep(
  s: CharacterState,
  input: CharacterInput,
  h: number,
  heightAt: (x: number, z: number) => number,
): CharacterState {
  let quat = s.quat;
  const vel = { ...s.vel };
  let onGround = s.onGround;

  if (onGround) {
    // Turning: yaw only, ground only (air control is ignored — spec).
    if (input.right && !input.left) {
      quat = quatNormalize(quatMultiply(quat, quatFromAxisAngle(Y_AXIS, CHAR_TURN_RATE * h)));
    } else if (input.left && !input.right) {
      quat = quatNormalize(quatMultiply(quat, quatFromAxisAngle(Y_AXIS, -CHAR_TURN_RATE * h)));
    }

    if (input.forward || input.back) {
      // Arcade move: the horizontal velocity is set directly along the
      // facing (local +Z projected on XZ — the quat is yaw-only).
      const fwd = quatRotateVector(quat, FORWARD_LOCAL);
      const dir = vecNormalize({
        x: fwd.x * ((input.forward ? 1 : 0) - (input.back ? 1 : 0)),
        y: 0,
        z: fwd.z * ((input.forward ? 1 : 0) - (input.back ? 1 : 0)),
      });
      const speed = input.run ? CHAR_RUN_SPEED : CHAR_WALK_SPEED;
      vel.x = dir.x * speed;
      vel.z = dir.z * speed;
      vel.y = 0;
    } else {
      // No move input: ground friction decays the horizontal speed at
      // CHAR_GROUND_FRICTION u/s² (to a full stop, never reversing).
      const sp = Math.hypot(vel.x, vel.z);
      if (sp > 0) {
        const next = sp - CHAR_GROUND_FRICTION * h;
        const f = next <= 0 ? 0 : next / sp;
        vel.x *= f;
        vel.z *= f;
      }
      vel.y = 0;
      if (input.jump) {
        // Jump: only from the ground state (no double jump). Holding the
        // key re-triggers on every landing (v1 auto-hop, documented).
        vel.y = CHAR_JUMP_VELOCITY;
        onGround = false;
      }
    }
  } else {
    // Airborne: gravity, and the horizontal velocity is FROZEN (no air
    // control — move keys do nothing until landing).
    vel.y -= CHAR_GRAVITY * h;
  }

  const pos = {
    x: s.pos.x + vel.x * h,
    y: s.pos.y + vel.y * h,
    z: s.pos.z + vel.z * h,
  };
  const terrainY = heightAt(pos.x, pos.z);

  if (onGround) {
    // Terrain following: lerp the feet toward the surface at
    // CHAR_TERRAIN_LERP_SPEED u/s — slopes are tracked smoothly (the lerp
    // outruns any ≤ 45° slope at walk/run speed, so the gap never opens
    // and the character cannot sink into the terrain).
    pos.y += clamp(terrainY - pos.y, -CHAR_TERRAIN_LERP_SPEED * h, CHAR_TERRAIN_LERP_SPEED * h);
    // Walked off an edge: the surface dropped further below the feet than
    // the lerp can follow in this substep → airborne (projectile fall).
    if (pos.y > terrainY + OFF_GROUND_EPS_M) {
      onGround = false;
    }
  } else if (pos.y <= terrainY + LANDING_EPS_M) {
    // Landing: clamp to the surface, kill the downward velocity. Silent in
    // v1 (no landing animation — spec).
    pos.y = terrainY;
    vel.y = 0;
    onGround = true;
  }

  return { pos, vel, onGround, quat };
}
