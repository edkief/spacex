/**
 * Public surface of the camera rig module (TASK-27).
 *
 * Production consumers import from `@client/camera` (this barrel)
 * rather than reaching into the individual files. The barrel also
 * gates the test hook behind `import.meta.env.DEV` so production
 * builds tree-shake it.
 *
 * The barrel deliberately re-exports the constants alongside the
 * rig class — tests want to pin the constants (FOV, handoff
 * duration, etc.) without re-importing from `cameraMath.ts`, and
 * the renderer is the same: it reads `COCKPIT_OFFSET_M` etc. for
 * HUD overlays (e.g. the on-foot reticle position).
 */

export {
  COCKPIT_OFFSET_M,
  EXTERNAL_BACK_OFFSET_M,
  EXTERNAL_HEIGHT_OFFSET_M,
  EXTERNAL_LOOK_AHEAD_M,
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
  CameraRig,
  chasePose,
  clampPitch,
  cockpitPose,
  onFootPose,
} from "./CameraRig.js";

export type {
  CameraMode,
  CameraPose,
  CameraRigOptions,
  CharacterState,
  HeightAtFn,
  QuatLike,
  ShipState,
  Vec3Like,
} from "./types.js";

export type { HandoffPath } from "./handoffPath.js";

export { buildHandoffPath, lookQuatsFromPoses, sampleHandoffPath } from "./handoffPath.js";

export {
  collisionNudge,
  easeInOutCubic,
  expSmoothFactor,
  lerpPose,
  lookQuatFromPose,
  slerpLook,
  targetPoseFor,
} from "./cameraMath.js";

// The test hook surface is exported for both the dev install
// path AND the test suite. The dev install path is gated by
// `import.meta.env.DEV` in the renderer's startup code; the
// test suite imports the hook directly. Vite tree-shakes the
// dev-install branch from production builds.
export {
  createCameraRigTestHook,
  installCameraRigTestHook,
  uninstallCameraRigTestHook,
} from "./testHook.js";

export type { CameraRigTestHook } from "./testHook.js";
