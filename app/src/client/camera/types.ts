/**
 * Public type surface for the camera rig (TASK-27).
 *
 * The rig is a single `PerspectiveCamera` shared between flight and
 * on-foot modes. Both modes read a *target* (the ship or the
 * character) and the rig smooths toward it with a 100 ms time
 * constant. When the active mode changes, the rig runs a 600 ms
 * ease-in-out handoff that animates the camera from the current
 * pose to the new mode's pose along a collision-safe path.
 *
 * Pure-data types live here so the math helpers (`cameraMath.ts`)
 * and the rig (`CameraRig.ts`) can both import them without
 * pulling in three.js.
 */

/** A 3-D point or vector (1 u ≈ 1 m). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** A unit quaternion. */
export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * The two camera modes the rig knows about. v1 only uses
 * `'cockpit'` and `'onfoot'`. The `'space'` / `'atmosphere'` /
 * `'surface'` *regime* is a gameplay concern owned by TASK-25
 * and is independent of the camera mode.
 */
export type CameraMode = "cockpit" | "onfoot";

/** Minimal state the rig needs to know about the active ship. */
export interface ShipState {
  /** World position of the ship (m). */
  pos: Vec3Like;
  /** Ship orientation (the rig uses it to position + look). */
  quat: QuatLike;
}

/**
 * Minimal state the rig needs to know about the active character
 * (only used in `'onfoot'` mode). `yaw` and `pitch` are radians;
 * `pitch` is clamped to ±`PITCH_MAX_DEG`.
 */
export interface CharacterState {
  /** World position of the character (m). */
  pos: Vec3Like;
  /** Look azimuth (radians around world +Y). */
  yaw: number;
  /** Look elevation (radians, clamped to ±PITCH_MAX by the rig). */
  pitch: number;
}

/**
 * A snapshot of where the camera is / where it should be.
 *
 * `pos` is the camera world position; `lookAt` is the world point
 * the camera is aimed at. The rig never lets user input fight the
 * handoff animation — during a handoff, `lookAt` is computed from
 * the precomputed path, not from the live mouse-look state.
 */
export interface CameraPose {
  pos: Vec3Like;
  lookAt: Vec3Like;
}

/**
 * The terrain height callback. Returns the altitude (metres
 * above the local surface) at the given world-local `(x, z)` on
 * the active planet. A flat planet returns `0` for every query;
 * the rig lifts the handoff path so it always stays at least
 * `TERRAIN_CLEARANCE_M` above the highest sampled point.
 *
 * Sign convention matches `RegimePlanetContext.heightAt` from
 * `@shared/regime.ts`.
 */
export type HeightAtFn = (x: number, z: number) => number;

/** Options for the rig constructor. */
export interface CameraRigOptions {
  /** Vertical FOV in degrees (default 75 — spec constant). */
  fov?: number;
  /** Near plane (default 0.1). */
  near?: number;
  /** Far plane (default 50 000 m — covers atmosphere + a chunk of orbit). */
  far?: number;
  /**
   * The smoothing rate (per second) for the cockpit and on-foot
   * targets. `k=8` gives ~125 ms time constant which the spec
   * rounds to "100 ms feel". Exposed so tests can pin it.
   */
  smoothingK?: number;
  /**
   * Duration of the handoff animation in milliseconds. The spec
   * pins it at 600 ms.
   */
  handoffDurationMs?: number;
  /**
   * How many points to sample along the handoff path when
   * checking it against `heightAt`. The spec says 5.
   */
  handoffPathSamples?: number;
  /**
   * Vertical clearance the handoff path keeps above the terrain
   * (m). The nudge lifts the entire path if any sample comes
   * within this margin of the surface.
   */
  terrainClearanceM?: number;
  /**
   * Terrain height callback. If absent the rig assumes a flat
   * planet (heightAt = 0), which means the nudge never fires.
   */
  heightAt?: HeightAtFn;
}
