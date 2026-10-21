/**
 * Pure math helpers for the camera rig (TASK-27).
 *
 * Everything in this file is dependency-free: no three.js, no DOM,
 * no Date.now(). The rig class (`CameraRig.ts`) is responsible for
 * orchestrating these helpers, advancing the handoff, and pushing
 * the result onto a real `PerspectiveCamera`. The functions here
 * take plain objects so the unit suite can run under Node.
 *
 * Conventions:
 *   - Right-handed, +Y up.
 *   - Rotations are intrinsic; `quatFromEuler(yaw, pitch, 0)`
 *     gives a yaw-then-pitch rotation.
 *   - `lookAt` is always a finite point; the rig will never feed
 *     a NaN in here.
 *
 * @see ./types.ts   — the data shapes this module consumes.
 * @see ./CameraRig.ts — the orchestrator that drives these.
 */

import {
  quatFromEuler,
  quatSlerp,
  quatRotateVector,
  vecLerp,
  type Quat,
  type Vec3,
} from "@shared/physics/vec.js";

import type {
  CameraMode,
  CameraPose,
  CharacterState,
  HeightAtFn,
  QuatLike,
  ShipState,
  Vec3Like,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants (exported so tests can pin them and the rig can reference them)
// ---------------------------------------------------------------------------

/** Vertical FOV in degrees — the spec pins FOV at 75 for v1. */
export const FOV_DEG = 75;

/**
 * Ship-local cockpit offset (metres). `(0, 0.5, 1.2)` = 0.5 m up
 * (eye height above the cockpit floor) and 1.2 m forward of the
 * ship origin. The rig rotates this offset by the ship quat so
 * the camera follows the ship's heading.
 */
export const COCKPIT_OFFSET_M: Readonly<Vec3Like> = Object.freeze({ x: 0, y: 0.5, z: 1.2 });

/** How far behind the character the third-person camera sits (m). */
export const ON_FOOT_BACK_OFFSET_M = 4;

/** How far above the character the third-person camera sits (m). */
export const ON_FOOT_HEIGHT_OFFSET_M = 1.6;

/** TASK-74: chase camera lateral distance behind the ship (m). */
export const EXTERNAL_BACK_OFFSET_M = 8;

/** TASK-74: chase camera vertical distance above the ship (m). */
export const EXTERNAL_HEIGHT_OFFSET_M = 3;

/** TASK-74: chase camera look-ahead distance in front of the
 *  ship (m). The chase camera aims slightly ahead so the ship
 *  appears at the bottom-third of the frame rather than dead
 *  centre, which is the standard third-person flight framing. */
export const EXTERNAL_LOOK_AHEAD_M = 12;

/** Look-ahead distance for the on-foot camera (m). */
export const ON_FOOT_LOOK_AHEAD_M = 5;

/**
 * Mouse-look pitch clamp (degrees). The spec pins ±80. Anything
 * outside this range flips the camera or makes the player feel
 * sick, so the rig hard-clamps.
 */
export const PITCH_MAX_DEG = 80;
export const PITCH_MAX_RAD = (PITCH_MAX_DEG * Math.PI) / 180;

/** Handoff animation duration in ms. The spec pins 600. */
export const HANDOFF_DURATION_MS = 600;

/** Number of path samples checked against `heightAt` during a handoff. */
export const HANDOFF_PATH_SAMPLES = 5;

/** Minimum vertical clearance the handoff path keeps above terrain (m). */
export const TERRAIN_CLEARANCE_M = 1.5;

/** Smoothing rate (per second). The spec pins k=8. */
export const SMOOTHING_K = 8;

// ---------------------------------------------------------------------------
// Local copy helpers
// ---------------------------------------------------------------------------

/** Cheap copy of a `Vec3Like` (so callers never alias a pose). */
function v(v: Vec3Like): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** Finite check for a `Vec3Like` (rejects NaN/Infinity). */
function isFiniteVec(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

// ---------------------------------------------------------------------------
// Pitch clamp
// ---------------------------------------------------------------------------

/**
 * Clamp `pitch` to ±`PITCH_MAX_RAD` (a hard wall — the rig never
 * lets the player's look angle escape this range).
 *
 * Defensive guards:
 *   - `NaN` is coerced to 0 so a faulty input source can't
 *     poison the rig.
 *   - `+Infinity` clamps to `+PITCH_MAX_RAD`; `-Infinity` to
 *     `-PITCH_MAX_RAD`. Both are well-defined inputs and the
 *     clamp behaviour is more useful than a hard reset to 0.
 */
export function clampPitch(pitch: number): number {
  if (Number.isNaN(pitch)) return 0;
  if (pitch > PITCH_MAX_RAD) return PITCH_MAX_RAD;
  if (pitch < -PITCH_MAX_RAD) return -PITCH_MAX_RAD;
  return pitch;
}

// ---------------------------------------------------------------------------
// Pose factories
// ---------------------------------------------------------------------------

/**
 * Compute the cockpit pose (camera world position + look-at point)
 * for the given ship state.
 *
 *   - Camera position = `ship.pos + ship.quat * COCKPIT_OFFSET_M`
 *     (0.5 m up + 1.2 m forward of the ship origin, in ship-local
 *     space).
 *   - Look-at = camera position + ship forward (the ship forward
 *     is `+Z` rotated by the ship quat, scaled so the look-at
 *     stays far enough away to be numerically stable).
 */
export function cockpitPose(ship: ShipState): CameraPose {
  const forward = quatRotateVector(ship.quat as Quat, { x: 0, y: 0, z: 1 });
  // Camera position = ship.pos + ship.quat * COCKPIT_OFFSET_M.
  // We use the shared `quatRotateVector` helper so the rotation
  // is consistent with the rest of the flight model.
  const localOffset = quatRotateVector(ship.quat as Quat, COCKPIT_OFFSET_M as Vec3);
  const pos: Vec3Like = {
    x: ship.pos.x + localOffset.x,
    y: ship.pos.y + localOffset.y,
    z: ship.pos.z + localOffset.z,
  };
  // Sanity check: if a buggy caller fed in NaN, we don't want to
  // poison downstream poses. Coerce to the origin rather than
  // throw — the rig is a leaf node, an exception here would
  // crash the render loop. Tests exercise the finite-input path.
  if (!isFiniteVec(pos)) {
    return { pos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 5 } };
  }
  return {
    pos,
    lookAt: {
      x: pos.x + forward.x * 10,
      y: pos.y + forward.y * 10,
      z: pos.z + forward.z * 10,
    },
  };
}

/**
 * Compute the on-foot pose (third-person camera) for the given
 * character state. The camera is `ON_FOOT_BACK_OFFSET_M` metres
 * behind the character's look direction and
 * `ON_FOOT_HEIGHT_OFFSET_M` metres above the character root.
 *
 * The look direction is the character's `(yaw, pitch)` mouse-look
 * state — the rig does NOT take yaw from the ship's quat, so
 * the camera can decouple from the character body once the
 * handoff lands.
 */
export function onFootPose(character: CharacterState): CameraPose {
  // Clamp the pitch defensively — the rig should already have
  // clamped it, but a faulty caller (e.g. a debug seam that
  // bypasses the rig) shouldn't be able to look at the sky.
  const pitch = clampPitch(character.pitch);
  // Convention: positive `pitch` = look up (the natural FPS
  // convention). The shared `quatFromEuler` follows the
  // right-hand rule, so a positive `pitch` rotation around
  // +X would tilt the look direction DOWN. We negate the pitch
  // to align the user-facing convention with the math.
  const lookQuat = quatFromEuler(character.yaw, -pitch, 0);
  const forward = quatRotateVector(lookQuat, { x: 0, y: 0, z: 1 });
  // Camera sits behind the look direction (`-forward * 4`) and
  // up the world Y axis (`+1.6 m`). Using world up here (rather
  // than the character's local up) is the standard third-person
  // camera behaviour — the camera never tilts with the character
  // body, only rotates around the world up axis.
  const pos: Vec3Like = {
    x: character.pos.x - forward.x * ON_FOOT_BACK_OFFSET_M,
    y: character.pos.y + ON_FOOT_HEIGHT_OFFSET_M,
    z: character.pos.z - forward.z * ON_FOOT_BACK_OFFSET_M,
  };
  const lookAt: Vec3Like = {
    x: character.pos.x + forward.x * ON_FOOT_LOOK_AHEAD_M,
    y: character.pos.y + forward.y * ON_FOOT_LOOK_AHEAD_M,
    z: character.pos.z + forward.z * ON_FOOT_LOOK_AHEAD_M,
  };
  if (!isFiniteVec(pos) || !isFiniteVec(lookAt)) {
    return { pos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 5 } };
  }
  return { pos, lookAt };
}

/**
 * TASK-74: chase / external camera pose for flight. The camera
 * sits `EXTERNAL_BACK_OFFSET_M` metres behind the ship (along
 * the negated ship-forward axis) and `EXTERNAL_HEIGHT_OFFSET_M`
 * above, aiming `EXTERNAL_LOOK_AHEAD_M` metres ahead of the
 * ship so the ship appears at the bottom-third of the frame.
 *
 * Like `cockpitPose` the chase pose follows the ship quat, so a
 * rolling ship rolls the camera with it (the rig's smoothing
 * masks the per-frame jitter; the smoothFactor already runs at
 * 100 ms feel).
 *
 * If the input is non-finite (a buggy caller feeding NaN) we
 * fall back to the origin so the rig never poisons downstream
 * poses.
 */
export function chasePose(ship: ShipState): CameraPose {
  const forward = quatRotateVector(ship.quat as Quat, { x: 0, y: 0, z: 1 });
  const up = quatRotateVector(ship.quat as Quat, { x: 0, y: 1, z: 0 });
  const back = { x: -forward.x, y: -forward.y, z: -forward.z };
  // Camera position = ship - forward * BACK + up * HEIGHT.
  const pos: Vec3Like = {
    x: ship.pos.x + back.x * EXTERNAL_BACK_OFFSET_M + up.x * EXTERNAL_HEIGHT_OFFSET_M,
    y: ship.pos.y + back.y * EXTERNAL_BACK_OFFSET_M + up.y * EXTERNAL_HEIGHT_OFFSET_M,
    z: ship.pos.z + back.z * EXTERNAL_BACK_OFFSET_M + up.z * EXTERNAL_HEIGHT_OFFSET_M,
  };
  const lookAt: Vec3Like = {
    x: ship.pos.x + forward.x * EXTERNAL_LOOK_AHEAD_M,
    y: ship.pos.y + forward.y * EXTERNAL_LOOK_AHEAD_M,
    z: ship.pos.z + forward.z * EXTERNAL_LOOK_AHEAD_M,
  };
  if (!isFiniteVec(pos) || !isFiniteVec(lookAt)) {
    return { pos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 5 } };
  }
  return { pos, lookAt };
}

/** Compute the target pose for the given mode + state. */
export function targetPoseFor(
  mode: CameraMode,
  ship: ShipState | null,
  character: CharacterState | null,
): CameraPose | null {
  if (mode === "cockpit") {
    if (ship === null) return null;
    return cockpitPose(ship);
  }
  if (mode === "external") {
    if (ship === null) return null;
    return chasePose(ship);
  }
  if (character === null) return null;
  return onFootPose(character);
}

// ---------------------------------------------------------------------------
// Lerp / slerp
// ---------------------------------------------------------------------------

/**
 * Linear interpolation between two camera poses. Position lerps
 * component-wise, look-at lerps component-wise. Returned as fresh
 * objects (no aliasing).
 */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return { pos: v(vecLerp(a.pos, b.pos, t)), lookAt: v(vecLerp(a.lookAt, b.lookAt, t)) };
}

/**
 * Slerp between two look directions encoded as quaternions.
 * Convenience wrapper so the rig doesn't have to import the
 * shared vec module directly.
 */
export function slerpLook(a: QuatLike, b: QuatLike, t: number): QuatLike {
  return quatSlerp(a as Quat, b as Quat, t) as QuatLike;
}

/**
 * Exponential smoothing factor for a given `dt` and rate `k`. The
 * resulting factor is `1 - exp(-k * dt)` — the closed-form limit
 * of a per-frame `lerp(target, current, 1 - alpha)` loop. The rig
 * uses it to:
 *   1. Smooth the cockpit pose toward the live ship pose
 *      (100 ms feel).
 *   2. Smooth the on-foot pose toward the live character pose
 *      (same 100 ms feel).
 *   3. Step the eased-handoff alpha with the same k so the
 *      animation tail is framerate-independent.
 */
export function expSmoothFactor(k: number, dt: number): number {
  if (dt <= 0) return 0;
  if (!Number.isFinite(dt) || !Number.isFinite(k)) return 0;
  return 1 - Math.exp(-k * dt);
}

// ---------------------------------------------------------------------------
// Collision nudge
// ---------------------------------------------------------------------------

/**
 * Sample the straight handoff path between `from` and `to`
 * against `heightAt`. If any sample sits within
 * `TERRAIN_CLEARANCE_M` of the terrain, lift the entire path so
 * the highest-risk sample sits at `terrainHeight + clearance`.
 *
 * Returns a single `lift` (metres) that the caller should add to
 * the `y` component of every interpolated point. `lift === 0`
 * means the straight path is already clear.
 *
 * The math:
 *   - We sample `N+1` points along the lerp (0, 1/N, 2/N, …, 1).
 *   - For each sample `(px, pz, py)`, compute the local
 *     `(localX, localZ) = (px - planetCenter.x, pz - planetCenter.z)`
 *     and look up `heightAt(localX, localZ)` to get the
 *     terrain altitude in the same units as `py`.
 *   - `terrainY = planetCenter.y + heightAt` is the world-space
 *     floor at that `(x, z)`. The straight path `y` at this point
 *     is `from.y + (to.y - from.y) * t`. We need
 *     `straightY >= terrainY + clearance`, so
 *     `lift >= (terrainY + clearance) - straightY`.
 *   - Take the max across samples; that's the nudge.
 *
 * If `planetCenter` is `null` the rig assumes a flat ground plane
 * at `y=0` (i.e. treats the world itself as the floor).
 */
export function collisionNudge(
  from: Vec3Like,
  to: Vec3Like,
  heightAt: HeightAtFn | undefined,
  planetCenter: Vec3Like | null,
  clearance: number,
  samples: number,
): number {
  if (heightAt === undefined) return 0;
  const n = Math.max(1, Math.floor(samples));
  const cx = planetCenter?.x ?? 0;
  const cz = planetCenter?.z ?? 0;
  const cy = planetCenter?.y ?? 0;
  let maxLift = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = from.x + (to.x - from.x) * t;
    const pz = from.z + (to.z - from.z) * t;
    const py = from.y + (to.y - from.y) * t;
    const terrainY = cy + heightAt(px - cx, pz - cz);
    const required = terrainY + clearance;
    const lift = required - py;
    if (lift > maxLift) maxLift = lift;
  }
  return maxLift > 0 ? maxLift : 0;
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/**
 * Cubic ease-in-out. The spec calls for "ease-in-out" without
 * pinning a curve; cubic is the canonical choice and gives a
 * smooth start AND finish so the camera doesn't snap at either
 * end of the handoff.
 *
 *   f(0)   = 0
 *   f(0.5) = 0.5
 *   f(1)   = 1
 *   f'(0)  = 0  (smooth start)
 *   f'(1)  = 0  (smooth end)
 */
export function easeInOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t < 0.5) {
    const u = t * 2;
    return 0.5 * u * u * u;
  }
  const u = (1 - t) * 2;
  return 1 - 0.5 * u * u * u;
}

// ---------------------------------------------------------------------------
// Look-direction quaternion (used by the handoff path builder)
// ---------------------------------------------------------------------------

/**
 * Build a "look direction" quaternion from a pose's
 * `pos → lookAt` vector. Used to seed the slerp that the
 * handoff path samples. The look-at vector is the world-space
 * difference `lookAt - pos` normalised and converted to a
 * yaw-then-pitch quaternion.
 *
 * The forward vector is `+Z` in world space, so the resulting
 * quaternion is `quatFromEuler(yaw, -pitch, 0)` where
 *   - yaw   = atan2(dx, dz)
 *   - pitch = atan2(dy, sqrt(dx² + dz²))
 *
 * The `-pitch` cancels the right-hand rule of `quatFromEuler`
 * (a positive `pitch` rotation around +X would tilt +Z toward
 * -Y, so we negate to make look-up = positive pitch). This
 * matches the convention `onFootPose` uses and keeps the
 * handoff path consistent with the source/target poses.
 *
 * Both `pos` and `lookAt` are finite by construction (the
 * factories clamp NaN to the origin) but we still guard against
 * the degenerate `pos === lookAt` case.
 */
export function lookQuatFromPose(pose: CameraPose): QuatLike {
  const dx = pose.lookAt.x - pose.pos.x;
  const dy = pose.lookAt.y - pose.pos.y;
  const dz = pose.lookAt.z - pose.pos.z;
  const horiz = Math.sqrt(dx * dx + dz * dz);
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.atan2(dy, horiz);
  return quatFromEuler(yaw, -pitch, 0) as QuatLike;
}
