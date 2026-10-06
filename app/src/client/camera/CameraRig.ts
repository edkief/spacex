/**
 * TASK-27: the continuous camera — one PerspectiveCamera (FOV 75) for
 * EVERYTHING. Two modes:
 *
 *  - 'cockpit' — ship-local offset (0, 0.5, 1.2) rotated by the ship quat,
 *    looking along the ship forward; the smoothed state chases the target
 *    pose exponentially (k = 8/s → the ~100 ms follow lag, spec).
 *    (TASK-72: kept available but unused by default — the in-ship view is
 *    'chase'.)
 *  - 'chase'   — TASK-72: third person behind the ship: ship-local
 *    (0, 4, -14) rotated by the ship quat, looking 20 u ahead. The default
 *    in-ship view.
 *  - 'onfoot'  — third person: 4 m behind the character, 1.6 m up,
 *    mouse-look yaw/pitch (pitch clamped ±80°).
 *
 * Mode switches never cut or teleport: `handoff` precomputes a 5-sample
 * safe path (position lerp + look slerp, terrain-nudged against heightAt)
 * and animates from→to over 600 ms ease-in-out. During the animation the
 * camera is NOT user-controllable (look deltas are dropped — gameplay
 * input is still accepted upstream; only THIS rig is locked) and the
 * animation is cancellable only by a SECOND handoff, never by input.
 *
 * The rig is DOM-free except the THREE camera it drives; the clock is
 * injectable so the whole thing unit-tests on a fixed frame grid.
 */

import * as THREE from 'three';

import {
  chasePose,
  cockpitPose,
  computeHandoffPath,
  easeInOutCubic,
  clampPitchRad,
  FLAT_GROUND,
  HANDOFF_DURATION_MS,
  onFootPose,
  samplePath,
  type CameraMode,
  type CharacterState,
  type Pose,
  type ShipState,
  type Vec3,
} from './pose-math';

/** Exponential follow rate (spec: k = 8/s ≈ 100 ms time constant). */
export const SMOOTH_K = 8;

/** The single camera the rig drives (spec: one camera, FOV 75 constant). */
export const CAMERA_FOV = 75;

export interface CameraRigOptions {
  /** The one camera (owned by the caller, e.g. WorldManager). */
  camera: THREE.PerspectiveCamera;
  /** Terrain sampler for the handoff nudge (default: flat y = 0). */
  heightAt?: (x: number, z: number) => number;
  /** Injectable clock in ms (tests); default performance.now. */
  now?: () => number;
  /** Handoff lifecycle hooks (debug overlay / tests). */
  onHandoffStart?: (to: CameraMode) => void;
  onHandoffEnd?: (to: CameraMode) => void;
}

/**
 * Owns the shared camera across regimes. Call `update(dtSec)` every frame;
 * feed fresh transforms via `setShip` / `setCharacterPosition`; switch
 * modes via `handoff` (which starts the 600 ms animation).
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  /** The mode the rig settles in (after any in-flight handoff). */
  mode: CameraMode = 'cockpit';

  /** True while a handoff animation owns the camera (input lock). */
  inputLocked = false;

  /** Total handoff animations started (diagnostics/tests). */
  handoffStarts = 0;

  /** The precomputed path of the in-flight (or last finished) handoff. */
  lastPath: Pose[] | null = null;

  private readonly heightAt: (x: number, z: number) => number;
  private readonly now: () => number;
  private readonly onHandoffStart?: (to: CameraMode) => void;
  private readonly onHandoffEnd?: (to: CameraMode) => void;

  private ship: ShipState = {
    pos: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
  };
  private character: CharacterState = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  private lookYaw = 0;
  private lookPitch = 0;

  // Smoothed camera state (what the camera actually shows each frame).
  private curPos: THREE.Vector3;
  private curQuat: THREE.Quaternion;
  private primed = false;

  // In-flight handoff (null = steady-state following).
  private handoffTo: CameraMode | null = null;
  private handoffStart = 0;

  private readonly tmpMatrix = new THREE.Matrix4();

  constructor(options: CameraRigOptions) {
    this.camera = options.camera;
    this.heightAt = options.heightAt ?? FLAT_GROUND;
    this.now = options.now ?? (() => performance.now());
    this.onHandoffStart = options.onHandoffStart;
    this.onHandoffEnd = options.onHandoffEnd;

    this.camera.fov = CAMERA_FOV;
    this.camera.updateProjectionMatrix();
    this.curPos = this.camera.position.clone();
    this.curQuat = this.camera.quaternion.clone();
  }

  /** Fresh ship transform (client prediction / interpolation feed). */
  setShip(pos: Vec3, quat: { x: number; y: number; z: number; w: number }): void {
    this.ship = { pos, quat };
  }

  /** Fresh on-foot character position (yaw/pitch stay rig-owned). */
  setCharacterPosition(pos: Vec3): void {
    this.character = { ...this.character, pos };
  }

  /** Current mouse-look angles (radians, pitch already clamped). */
  get lookAngles(): { yaw: number; pitch: number } {
    return { yaw: this.lookYaw, pitch: this.lookPitch };
  }

  /**
   * Mouse-look delta (on-foot only). Dropped — returns false — when the
   * rig is in cockpit mode OR a handoff is in flight: gameplay input is
   * still accepted upstream, the camera just cannot be fought mid-anim.
   */
  applyLookDelta(dyaw: number, dpitch: number): boolean {
    if (this.inputLocked || this.mode !== 'onfoot') return false;
    this.lookYaw += dyaw;
    this.lookPitch = clampPitchRad(this.lookPitch + dpitch);
    return true;
  }

  /**
   * Start (or re-start) the 600 ms handoff toward `to`. Precomputes the
   * safe 5-sample path from the CURRENT (smoothed) pose — so a second
   * handoff mid-animation picks up exactly where the first one is.
   * Returns false when there is nothing to do (same mode, no animation).
   */
  handoff(to: CameraMode): boolean {
    if (to === this.mode && this.handoffTo === null) return false;
    const from = this.currentPose();
    const toPose = this.targetPose(to);
    this.lastPath = computeHandoffPath(from, toPose, this.heightAt);
    this.handoffTo = to;
    this.handoffStart = this.now();
    this.inputLocked = true;
    this.handoffStarts += 1;
    this.onHandoffStart?.(to);
    return true;
  }

  /**
   * One frame. During a handoff the camera walks the precomputed path
   * (eased); in steady state it exponentially chases the mode's target
   * pose (position lerp + quaternion slerp, k = 8/s).
   */
  update(dtSec: number): void {
    if (dtSec <= 0) return;
    const nowMs = this.now();
    if (this.handoffTo !== null) {
      const t = (nowMs - this.handoffStart) / HANDOFF_DURATION_MS;
      if (t >= 1) {
        // Land exactly on the path's final (nudged) sample: continuous,
        // and equal to the destination pose whenever that pose is clear.
        const finalSample = this.lastPath
          ? this.lastPath[this.lastPath.length - 1]
          : this.targetPose(this.handoffTo);
        this.applyPose(finalSample);
        this.mode = this.handoffTo;
        this.handoffTo = null;
        this.inputLocked = false;
        this.onHandoffEnd?.(this.mode);
        return;
      }
      const pose = samplePath(this.lastPath ?? [this.currentPose()], easeInOutCubic(t));
      this.applyPose(pose);
      return;
    }

    const target = this.targetPose(this.mode);
    if (!this.primed) {
      // First frame: snap (no visible chase from the camera's spawn pose).
      this.applyPose(target);
      return;
    }
    const f = 1 - Math.exp(-SMOOTH_K * dtSec);
    this.curPos.lerp(targetVec3(target.position), f);
    this.tmpMatrix.lookAt(this.curPos, targetVec3(target.look), UP);
    const targetQuat = quatFromMatrix(this.tmpMatrix);
    this.curQuat.slerp(targetQuat, f);
    this.camera.position.copy(this.curPos);
    this.camera.quaternion.copy(this.curQuat);
  }

  /** The pose the camera currently shows (smoothed path / follow state). */
  currentPose(): Pose {
    // Camera forward is local -Z (three.js convention); 10 u ahead is the
    // convention `handoff` uses for its look target.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const look = this.camera.position.clone().addScaledVector(forward, 10);
    return {
      position: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
      },
      look: { x: look.x, y: look.y, z: look.z },
    };
  }

  private targetPose(mode: CameraMode): Pose {
    if (mode === 'onfoot') {
      return onFootPose({
        pos: this.character.pos,
        yaw: this.lookYaw,
        pitch: this.lookPitch,
      });
    }
    if (mode === 'chase') {
      return chasePose(this.ship);
    }
    return cockpitPose(this.ship);
  }

  /**
   * Forget the smoothed state: the NEXT update() snaps to the mode's target
   * pose instead of chasing from where the camera is (the boot path — a
   * handoff animation from the manager's spectator vantage is not wanted
   * there; TASK-72). No-op until the next frame runs.
   */
  resetPrime(): void {
    this.primed = false;
  }

  /** Snap the smoothed state (and the camera) to an exact pose. */
  private applyPose(pose: Pose): void {
    const pos = targetVec3(pose.position);
    const look = targetVec3(pose.look);
    this.curPos.copy(pos);
    this.tmpMatrix.lookAt(pos, look, UP);
    this.curQuat.copy(quatFromMatrix(this.tmpMatrix));
    this.primed = true;
    this.camera.position.copy(this.curPos);
    this.camera.quaternion.copy(this.curQuat);
  }
}

const UP = new THREE.Vector3(0, 1, 0);

function targetVec3(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

/** Quaternion for the rotation matrix a Matrix4.lookAt produces (camera basis). */
function quatFromMatrix(m: THREE.Matrix4): THREE.Quaternion {
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
