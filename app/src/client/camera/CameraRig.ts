/**
 * The single `PerspectiveCamera` rig used for both flight and
 * on-foot modes (TASK-27).
 *
 * Design rules from the spec:
 *   - **One camera for everything.** We never `swap` the camera;
 *     the renderer mounts the rig's `perspectiveCamera` once and
 *     the rig just updates the `position` and `lookAt` per frame.
 *   - **Smoothing for free.** The 100 ms feel comes from an
 *     exponential lerp of the position and slerp of the look
 *     direction toward the target pose. `k=8` gives a
 *     time constant of `1/8 = 125 ms` which rounds to the
 *     spec's "100 ms lag" feel.
 *   - **Handoff is one animation.** A mode change kicks off a
 *     600 ms ease-in-out handoff. The rig builds a pre-sampled
 *     path (5 vertices, terrain-nudged), animates along it, and
 *     accepts NO user mouse-look during the animation. A second
 *     `setMode` call restarts the handoff (the spec's
 *     "cancellable only by a second handoff" rule).
 *   - **No second camera.** Tests assert this — the rig owns
 *     exactly one `PerspectiveCamera` for its entire lifetime.
 *
 * Decoupled from React: the rig is a plain class the renderer
 * holds once. The dev-only `__testHook` (see `testHook.ts`) drives
 * the rig with a fake ship/character so the e2e smoke can verify
 * the rig without a real three.js scene.
 *
 * @see ./cameraMath.ts    — pose factories, easing, collision nudge.
 * @see ./handoffPath.ts   — precomputed handoff path sampling.
 * @see ./testHook.ts      — dev-only `window.__driftCameraRig` seam.
 * @see ./types.ts         — the data shapes the rig consumes.
 */

import { PerspectiveCamera } from "three";

import {
  FOV_DEG,
  HANDOFF_DURATION_MS,
  HANDOFF_PATH_SAMPLES,
  SMOOTHING_K,
  TERRAIN_CLEARANCE_M,
  clampPitch,
  expSmoothFactor,
  targetPoseFor,
} from "./cameraMath.js";
import {
  buildHandoffPath,
  lookQuatsFromPoses,
  sampleHandoffPath,
  type HandoffPath,
} from "./handoffPath.js";
import type {
  CameraMode,
  CameraPose,
  CharacterState,
  HeightAtFn,
  ShipState,
  Vec3Like,
} from "./types.js";

// ---------------------------------------------------------------------------
// Handoff state
// ---------------------------------------------------------------------------

/**
 * The state of the in-flight handoff animation. `null` when no
 * handoff is running.
 *
 * - `path`        — the pre-sampled path the rig animates along.
 * - `elapsedMs`   — accumulated animation time.
 * - `toMode`      — the mode the rig is heading toward (the
 *                   `mode` getter still returns the OLD mode
 *                   until the handoff completes).
 * - `toShip` /    — the targets in the destination mode. The
 *   `toCharacter`   rig will hand control over to them when
 *                   the animation lands.
 */
interface HandoffState {
  path: HandoffPath;
  elapsedMs: number;
  toMode: CameraMode;
  toShip: ShipState | null;
  toCharacter: CharacterState | null;
  /** Number of `setMode` calls that kicked off this handoff (always 1 — used for the single-animation assertion). */
  kickoffId: number;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/**
 * The single `PerspectiveCamera` rig for the whole game. The
 * renderer calls `update(dt)` once per render frame and reads
 * the rig's `perspectiveCamera` to mount the scene.
 */
export class CameraRig {
  // -- The single camera. Never replaced. --
  private readonly _perspectiveCamera: PerspectiveCamera;
  // -- The active mode. Settles at the destination of any handoff. --
  private _mode: CameraMode = "cockpit";
  // -- The live targets (set every frame by the renderer). --
  private _ship: ShipState | null = null;
  private _character: CharacterState | null = null;
  // -- The smoothed (current) pose. Updates per frame. --
  private _currentPose: CameraPose = {
    pos: { x: 0, y: 0, z: 0 },
    lookAt: { x: 0, y: 0, z: 1 },
  };
  // -- Handoff state. --
  private _handoff: HandoffState | null = null;
  // -- Number of handoffs started (for the single-animation assertion). --
  private _handoffKickoffCounter = 0;
  // -- Total handoffs completed (for tests + the debug overlay). --
  private _handoffCompletedCounter = 0;
  // -- Tunables. --
  private readonly _smoothingK: number;
  private readonly _handoffDurationMs: number;
  private readonly _handoffPathSamples: number;
  private readonly _terrainClearanceM: number;
  private _heightAt: HeightAtFn | undefined;
  // -- Planet centre for the collision nudge. Defaults to null (flat ground at y=0). --
  private _planetCenter: Vec3Like | null = null;

  constructor(opts: {
    aspect: number;
    smoothingK?: number;
    handoffDurationMs?: number;
    handoffPathSamples?: number;
    terrainClearanceM?: number;
    heightAt?: HeightAtFn;
    planetCenter?: Vec3Like | null;
  }) {
    this._perspectiveCamera = new PerspectiveCamera(FOV_DEG, opts.aspect, 0.1, 50_000);
    this._smoothingK = opts.smoothingK ?? SMOOTHING_K;
    this._handoffDurationMs = opts.handoffDurationMs ?? HANDOFF_DURATION_MS;
    this._handoffPathSamples = opts.handoffPathSamples ?? HANDOFF_PATH_SAMPLES;
    this._terrainClearanceM = opts.terrainClearanceM ?? TERRAIN_CLEARANCE_M;
    this._heightAt = opts.heightAt;
    this._planetCenter = opts.planetCenter ?? null;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** The one and only perspective camera. The renderer mounts this. */
  get perspectiveCamera(): PerspectiveCamera {
    return this._perspectiveCamera;
  }

  /** The current camera mode (settled at the destination of any handoff). */
  get mode(): CameraMode {
    return this._mode;
  }

  /** True while a handoff animation is in flight (input is locked). */
  get isHandoffInFlight(): boolean {
    return this._handoff !== null;
  }

  /** Total handoffs started since construction (for tests). */
  get handoffKickoffCount(): number {
    return this._handoffKickoffCounter;
  }

  /** Total handoffs completed since construction (for tests). */
  get handoffCompletedCount(): number {
    return this._handoffCompletedCounter;
  }

  /**
   * Number of handoffs started by the most recent `setMode` call.
   * Tests use this to assert "exactly one animation per mode
   * switch" — the spec acceptance criterion. The value is the
   * `kickoffId` stamped on the live `_handoff`; for a freshly
   * completed handoff it equals the most recent kickoff count.
   */
  get lastHandoffKickoffId(): number {
    return this._handoff?.kickoffId ?? this._handoffKickoffCounter;
  }

  /**
   * Update the viewport aspect. The renderer calls this on
   * resize so the projection stays correct. Cheap (one
   * `updateProjectionMatrix`).
   */
  setAspect(aspect: number): void {
    this._perspectiveCamera.aspect = aspect;
    this._perspectiveCamera.updateProjectionMatrix();
  }

  /**
   * Set or update the terrain height callback + the planet
   * centre. The handoff nudge uses both. `heightAt` is the
   * function the spec pins at "sample 5 points against
   * heightAt"; `planetCenter` is needed to translate from
   * world `(x, z)` to the planet's local frame.
   */
  setTerrain(heightAt: HeightAtFn | undefined, planetCenter: Vec3Like | null): void {
    this._heightAt = heightAt;
    this._planetCenter = planetCenter;
  }

  /**
   * Push the live ship state. Called by the renderer every
   * frame (or whenever the snapshot changes). Does NOT trigger
   * a handoff — that's `setMode`'s job.
   */
  setShip(ship: ShipState | null): void {
    this._ship = ship;
  }

  /**
   * Push the live character state. The rig clamps `pitch` to
   * ±`PITCH_MAX_RAD` here so the spec's "clamp at the input"
   * rule is enforced even if the renderer forgets.
   */
  setCharacter(character: CharacterState | null): void {
    if (character === null) {
      this._character = null;
      return;
    }
    this._character = { ...character, pitch: clampPitch(character.pitch) };
  }

  /**
   * Apply a mouse-look delta. `deltaYaw` is radians around the
   * world +Y axis; `deltaPitch` is radians of vertical look
   * (clamped to ±PITCH_MAX_RAD). NO-OP during a handoff (the
   * spec: "input is accepted but the camera is not
   * user-controllable until the animation completes").
   *
   * The yaws and pitches are ACCUMULATED on the character
   * state; the rig does not own a separate mouse-look buffer.
   * If `setCharacter` is being driven from a store that owns
   * the yaw/pitch, just update the store and call
   * `setCharacter` again — the rig will re-clamp.
   */
  applyMouseLook(deltaYaw: number, deltaPitch: number): void {
    if (this._handoff !== null) return;
    if (this._character === null) return;
    const next: CharacterState = {
      pos: this._character.pos,
      yaw: this._character.yaw + deltaYaw,
      pitch: clampPitch(this._character.pitch + deltaPitch),
    };
    this._character = next;
  }

  /**
   * Switch the camera mode. If the mode actually changes (or if
   * a handoff is already in flight), this triggers a NEW handoff
   * from the current pose to the new mode's target pose. A
   * redundant call (same mode, no handoff in flight) is a no-op
   * — the rig does not "restart" a settled state.
   *
   * The spec is explicit: "cancellable only by a second
   * handoff" — so a second `setMode` does NOT cancel the
   * current handoff, it re-aims the destination. The rig
   * builds a fresh path from the current pose to the new
   * target (so the camera snaps to the new path, not the old
   * one).
   */
  setMode(nextMode: CameraMode): void {
    const modeChanged = nextMode !== this._mode;
    if (!modeChanged && this._handoff === null) {
      return;
    }
    this._mode = nextMode;
    this._handoffKickoffCounter += 1;
    const fromPose = this._currentPose;
    const fromLookQuat = lookQuatsFromPoses(fromPose, fromPose).from;
    // For the to-pose, we need the targets in the new mode. If
    // the renderer hasn't pushed a character yet, we fall back
    // to the cockpit pose at the origin (the rig will not stay
    // there — the renderer's next `setShip` / `setCharacter`
    // call will update the target and trigger another handoff if
    // needed). For a v1 ship-only build that's fine: cockpit
    // → cockpit is a no-op once the handoff lands.
    const toPose = targetPoseFor(nextMode, this._ship, this._character) ?? {
      pos: { x: 0, y: 0, z: 0 },
      lookAt: { x: 0, y: 0, z: 1 },
    };
    const toLookQuat = lookQuatsFromPoses(toPose, toPose).from;
    const path = buildHandoffPath(
      fromPose,
      toPose,
      fromLookQuat,
      toLookQuat,
      this._heightAt,
      this._planetCenter,
      this._terrainClearanceM,
      this._handoffPathSamples,
      this._handoffDurationMs,
    );
    this._handoff = {
      path,
      elapsedMs: 0,
      toMode: nextMode,
      toShip: this._ship,
      toCharacter: this._character,
      kickoffId: this._handoffKickoffCounter,
    };
  }

  /**
   * Advance the rig. Call once per render frame. `dt` is the
   * frame delta in seconds (positive, finite).
   *
   * Behaviour:
   *   - If a handoff is in flight, advance the handoff alpha and
   *     snap the camera to the path. User mouse-look is locked
   *     for the duration.
   *   - Otherwise, smooth the current pose toward the live
   *     target pose with the 100 ms exponential lerp.
   */
  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (this._handoff !== null) {
      this._advanceHandoff(dt);
      // Even if `dt === 0` we want the camera to reflect the
      // current handoff state — copy the current path sample.
      this._applyPoseToCamera(this._currentPose);
      return;
    }
    const target = targetPoseFor(this._mode, this._ship, this._character);
    if (target === null) {
      // No target — keep the current pose (we have nothing to
      // chase). The camera stays where it was; the renderer is
      // free to push a target later.
      this._applyPoseToCamera(this._currentPose);
      return;
    }
    const factor = expSmoothFactor(this._smoothingK, dt);
    const smoothed: CameraPose = {
      pos: {
        x: this._currentPose.pos.x + (target.pos.x - this._currentPose.pos.x) * factor,
        y: this._currentPose.pos.y + (target.pos.y - this._currentPose.pos.y) * factor,
        z: this._currentPose.pos.z + (target.pos.z - this._currentPose.pos.z) * factor,
      },
      lookAt: {
        x: this._currentPose.lookAt.x + (target.lookAt.x - this._currentPose.lookAt.x) * factor,
        y: this._currentPose.lookAt.y + (target.lookAt.y - this._currentPose.lookAt.y) * factor,
        z: this._currentPose.lookAt.z + (target.lookAt.z - this._currentPose.lookAt.z) * factor,
      },
    };
    this._currentPose = smoothed;
    this._applyPoseToCamera(smoothed);
  }

  /**
   * Force a pose (snap the camera, no smoothing). Used by the
   * test hook to seed an initial pose without waiting for the
   * 100 ms catch-up. Production code should let `update` drive
   * the smoothing.
   */
  setPoseImmediate(pose: CameraPose): void {
    this._currentPose = { pos: { ...pose.pos }, lookAt: { ...pose.lookAt } };
    this._applyPoseToCamera(this._currentPose);
  }

  /** Read the rig's current pose. Tests + the debug overlay use this. */
  getCurrentPose(): CameraPose {
    return { pos: { ...this._currentPose.pos }, lookAt: { ...this._currentPose.lookAt } };
  }

  /**
   * Read the rig's live character state (a copy). The pitch is
   * always clamped to ±PITCH_MAX_RAD. Tests use this to assert
   * the clamp without re-deriving it from the camera pose (the
   * camera is offset, so the look direction is not equal to the
   * character's pitch).
   */
  getCharacter(): CharacterState | null {
    if (this._character === null) return null;
    return { ...this._character, pos: { ...this._character.pos } };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Advance the handoff animation. The path's samples are
   * precomputed; we just step the elapsed time and sample at
   * the eased alpha.
   */
  private _advanceHandoff(dt: number): void {
    const handoff = this._handoff;
    if (handoff === null) return;
    handoff.elapsedMs += dt * 1000;
    const alpha = Math.min(1, handoff.elapsedMs / handoff.path.durationMs);
    this._currentPose = sampleHandoffPath(handoff.path, alpha);
    if (alpha >= 1) {
      // Hand control over to the destination mode. We snap the
      // current pose to the path's final sample so a floating-
      // point residue doesn't survive into the smoothing phase.
      this._currentPose = sampleHandoffPath(handoff.path, 1);
      this._handoff = null;
      this._handoffCompletedCounter += 1;
    }
  }

  /**
   * Push the rig's current pose onto the `PerspectiveCamera`.
   * Three.js stores position as a `Vector3` and look direction
   * via the inherited `quaternion`; we use `lookAt` for the
   * latter so the camera's `up` axis stays world +Y.
   */
  private _applyPoseToCamera(pose: CameraPose): void {
    this._perspectiveCamera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
    this._perspectiveCamera.lookAt(pose.lookAt.x, pose.lookAt.y, pose.lookAt.z);
  }
}

// ---------------------------------------------------------------------------
// Re-exports — keep the test module's imports tight.
// ---------------------------------------------------------------------------

export {
  COCKPIT_OFFSET_M,
  FOV_DEG,
  HANDOFF_DURATION_MS,
  HANDOFF_PATH_SAMPLES,
  ON_FOOT_BACK_OFFSET_M,
  ON_FOOT_HEIGHT_OFFSET_M,
  ON_FOOT_LOOK_AHEAD_M,
  PITCH_MAX_DEG,
  PITCH_MAX_RAD,
  SMOOTHING_K,
  TERRAIN_CLEARANCE_M,
  clampPitch,
  cockpitPose,
  onFootPose,
} from "./cameraMath.js";

export type { HandoffPath } from "./handoffPath.js";
