/**
 * TASK-27: pure pose math for the continuous CameraRig.
 *
 * A "pose" is a camera position + a look target (both world Vec3). Every
 * function here is pure, DOM-free, and built on the shared deterministic
 * vector/quaternion ops (@shared/physics/vec), so the whole handoff —
 * cockpit pose, on-foot pose, lerp/slerp, ease curve, terrain nudge — is
 * unit-testable without a browser or a WebGL context.
 *
 * Conventions (match @shared/physics/vec): right-handed, +Y up, +Z is the
 * ship/character FORWARD. `pose.look` always lies ahead of `pose.position`
 * along the view direction (three.js cameras look down their local -Z, but
 * we never store quaternions here — only points the camera looks AT).
 */

import {
  quatFromEuler,
  quatIdentity,
  quatRotateVector,
  vecAdd,
  vecDot,
  vecLerp,
  vecNormalize,
  vecScale,
  vecSub,
} from '@shared/physics/vec';

export type { Quat, Vec3 } from '@shared/physics/vec';
import type { Quat, Vec3 } from '@shared/physics/vec';

/** One camera pose: where it is + where it looks. */
export interface Pose {
  position: Vec3;
  look: Vec3;
}

/** The three regimes the single camera serves (TASK-27, TASK-72). */
export type CameraMode = 'cockpit' | 'chase' | 'onfoot';

/** Cockpit offset in ship-local space (spec: (0, 0.5, 1.2)). */
export const COCKPIT_OFFSET: Vec3 = { x: 0, y: 0.5, z: 1.2 };
/** Look-ahead along the ship forward (local +Z) for the cockpit pose. */
export const COCKPIT_LOOK_AHEAD = 20;

/**
 * TASK-72: chase-cam offsets in ship-local space. The flight model's
 * forward is +Z (SPAWN_GATE_QUAT, COCKPIT_OFFSET), so BEHIND is -Z. Tuned
 * for the scout hull (~4.2 long, ~7.8 wide — ship-mesh.ts): 14 u back puts
 * the widest wingtip well inside the 75° FOV.
 */
export const CHASE_BEHIND = 14;
export const CHASE_HEIGHT = 4;
export const CHASE_LOOK_AHEAD = 20;

/** On-foot (spec): 4 m behind the character, 1.6 m up. */
export const ON_FOOT_BEHIND = 4;
export const ON_FOOT_HEIGHT = 1.6;

/** Mouse-look pitch clamp (spec): -80..+80 degrees. */
export const PITCH_LIMIT_DEG = 80;

/** Handoff duration (spec): 600 ms ease-in-out. */
export const HANDOFF_DURATION_MS = 600;

/** Handoff path samples (spec): 5 points nudged against heightAt. */
export const HANDOFF_SAMPLES = 5;

/** Fixed look-ahead length while walking the handoff path. */
export const HANDOFF_LOOK_AHEAD = 10;

/** Keep the camera at least this far above terrain while nudging. */
export const HANDOFF_CLEARANCE_M = 1.5;

/** Ship transform the cockpit pose derives from. */
export interface ShipState {
  pos: Vec3;
  quat: Quat;
}

/** Character transform the on-foot pose derives from. */
export interface CharacterState {
  pos: Vec3;
  /** Look yaw (radians, around +Y). */
  yaw: number;
  /** Look pitch (radians, clamped to ±PITCH_LIMIT_DEG by the rig). */
  pitch: number;
}

export function clampPitchDeg(deg: number): number {
  return Math.max(-PITCH_LIMIT_DEG, Math.min(PITCH_LIMIT_DEG, deg));
}

/** Clamp a pitch in radians into the ±80° mouse-look band. */
export function clampPitchRad(rad: number): number {
  return (clampPitchDeg((rad * 180) / Math.PI) * Math.PI) / 180;
}

/** Cockpit pose: ship.pos + ship.quat * (0, 0.5, 1.2), looking forward. */
export function cockpitPose(ship: ShipState): Pose {
  const ahead: Vec3 = { x: 0, y: COCKPIT_OFFSET.y, z: COCKPIT_LOOK_AHEAD };
  return {
    position: vecAdd(ship.pos, quatRotateVector(ship.quat, COCKPIT_OFFSET)),
    look: vecAdd(ship.pos, quatRotateVector(ship.quat, ahead)),
  };
}

/**
 * TASK-72: chase pose — the default in-ship view. The camera sits
 * ship-local (0, CHASE_HEIGHT, -CHASE_BEHIND) rotated by the ship quat
 * (behind + above), looking at a point CHASE_LOOK_AHEAD ahead of the ship
 * along its forward (+Z). Pure and deterministic, like the other poses.
 */
export function chasePose(ship: ShipState): Pose {
  const offset: Vec3 = { x: 0, y: CHASE_HEIGHT, z: -CHASE_BEHIND };
  const ahead: Vec3 = { x: 0, y: 0, z: CHASE_LOOK_AHEAD };
  return {
    position: vecAdd(ship.pos, quatRotateVector(ship.quat, offset)),
    look: vecAdd(ship.pos, quatRotateVector(ship.quat, ahead)),
  };
}

/**
 * On-foot pose: the head point (feet + 1.6 m) is the look target; the
 * camera sits 4 m BEHIND it along the yaw/pitch look direction.
 */
export function onFootPose(character: CharacterState): Pose {
  const q = quatFromEuler(character.yaw, character.pitch, 0);
  const head: Vec3 = {
    x: character.pos.x,
    y: character.pos.y + ON_FOOT_HEIGHT,
    z: character.pos.z,
  };
  const dir = quatRotateVector(q, { x: 0, y: 0, z: 1 });
  return { position: vecSub(head, vecScale(dir, ON_FOOT_BEHIND)), look: head };
}

/** Linear interpolation between two poses, t clamped to [0, 1]. */
export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  return { position: vecLerp(a.position, b.position, tt), look: vecLerp(a.look, b.look, tt) };
}

/**
 * Spherical lerp of two (near) unit direction vectors, short arc — the
 * vector analogue of quatSlerp used for the handoff "slerp of look".
 */
export function slerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  let bb = b;
  let dot = vecDot(a, b);
  if (dot < 0) {
    bb = vecScale(b, -1);
    dot = -dot;
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const s = Math.sin(theta);
  if (s < 1e-12) return { ...a };
  const so = Math.sin(theta * tt) / s;
  const sa = Math.sin(theta * (1 - tt)) / s;
  return vecNormalize(vecAdd(vecScale(a, sa), vecScale(bb, so)));
}

/** Classic smooth ease-in-out (cubic), t clamped to [0, 1]. */
export function easeInOutCubic(t: number): number {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  return tt < 0.5 ? 4 * tt * tt * tt : 1 - Math.pow(-2 * tt + 2, 3) / 2;
}

/**
 * Raise a pose OUT of terrain: if the camera point is below
 * `heightAt(x, z) + clearance`, lift position.y (and look.y when it is
 * also underground) to the clearance line. x/z are never touched — the
 * path stays on its lerp line, only the altitude is corrected.
 */
export function nudgeOutOfTerrain(pose: Pose, heightAt: (x: number, z: number) => number): Pose {
  const floor = heightAt(pose.position.x, pose.position.z) + HANDOFF_CLEARANCE_M;
  const position = pose.position.y < floor ? { ...pose.position, y: floor } : pose.position;
  const lookFloor = heightAt(pose.look.x, pose.look.z) + 0.5;
  const look = pose.look.y < lookFloor ? { ...pose.look, y: lookFloor } : pose.look;
  return { position, look };
}

/**
 * Precomputed handoff path: HANDOFF_SAMPLES poses at t = 0 … 1 —
 * position lerp + look-direction slerp (re-anchored a fixed HANDOFF_LOOK_AHEAD
 * ahead), each sample nudged clear of terrain via heightAt.
 */
export function computeHandoffPath(
  from: Pose,
  to: Pose,
  heightAt: (x: number, z: number) => number,
): Pose[] {
  const fromDir = vecNormalize(vecSub(from.look, from.position));
  const toDir = vecNormalize(vecSub(to.look, to.position));
  const path: Pose[] = [];
  for (let i = 0; i < HANDOFF_SAMPLES; i++) {
    const t = i / (HANDOFF_SAMPLES - 1);
    const position = vecLerp(from.position, to.position, t);
    const look = vecAdd(position, vecScale(slerpVec(fromDir, toDir, t), HANDOFF_LOOK_AHEAD));
    path.push(nudgeOutOfTerrain({ position, look }, heightAt));
  }
  return path;
}

/**
 * Sample the precomputed path at eased progress e in [0, 1]: linear
 * interpolation between the stored (already-nudged) samples.
 */
export function samplePath(path: Pose[], e: number): Pose {
  const n = path.length;
  if (n === 1) return path[0];
  const u = Math.min(1, Math.max(0, e)) * (n - 1);
  const i = Math.min(Math.floor(u), n - 2);
  return lerpPose(path[i], path[i + 1], u - i);
}

/** Flat ground at y = 0 — the default heightAt until terrain streams (TASK-26). */
export const FLAT_GROUND: (x: number, z: number) => number = () => 0;

/** Identity-quat convenience for tests/fixtures (ship facing +Z at origin). */
export const IDENTITY_SHIP: ShipState = { pos: { x: 0, y: 0, z: 0 }, quat: quatIdentity() };
