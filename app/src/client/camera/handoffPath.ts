/**
 * Handoff-path construction (TASK-27).
 *
 * Builds a pre-sampled path the rig animates along when the
 * camera mode changes. The path:
 *   1. Lerps the position from `from.pos` to `to.pos`.
 *   2. Slerps the look direction between `fromLookQuat` and
 *      `toLookQuat`, producing an interpolated look-at at
 *      every sample.
 *   3. Lifts the entire path by `lift` metres if any sample
 *      comes within `TERRAIN_CLEARANCE_M` of the terrain.
 *
 * Splitting the path builder out of `cameraMath.ts` keeps the
 * math file focused on pose math and lets the rig orchestrator
 * (`CameraRig.ts`) import either side independently. The rig
 * also owns the easing + interpolation of the path during
 * animation — see `sampleHandoffPath` at the bottom.
 *
 * @see ./cameraMath.ts — pose factories + easing + nudge.
 * @see ./CameraRig.ts  — orchestrator that consumes the path.
 */

import { quatRotateVector, quatSlerp, type Quat } from "@shared/physics/vec.js";

import type { CameraPose, HeightAtFn, QuatLike, Vec3Like } from "./types.js";
import { easeInOutCubic } from "./cameraMath.js";
import { collisionNudge, lookQuatFromPose } from "./cameraMath.js";

// ---------------------------------------------------------------------------
// Path shape
// ---------------------------------------------------------------------------

/**
 * The precomputed handoff path the rig animates along. Immutable
 * for the duration of the handoff — a second `setMode` call while
 * a handoff is in flight builds a new path and discards the old
 * one (the spec's "cancellable only by a second handoff" rule).
 */
export interface HandoffPath {
  /** The sample positions along the lerp (N+1 points). */
  readonly positions: readonly Vec3Like[];
  /** The look-at points along the slerp (N+1 points). */
  readonly lookAts: readonly Vec3Like[];
  /**
   * The vertical nudge (metres) added to every sample. `0` if
   * the straight path was already above terrain.
   */
  readonly lift: number;
  /** Total duration in ms (copied from the rig for the handoff). */
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Path builder
// ---------------------------------------------------------------------------

/**
 * Build a handoff path: `N+1` interpolated poses from `from` to
 * `to`, slerped look-ats, and a single `lift` that keeps the
 * entire path above the terrain.
 */
export function buildHandoffPath(
  from: CameraPose,
  to: CameraPose,
  fromLookQuat: QuatLike,
  toLookQuat: QuatLike,
  heightAt: HeightAtFn | undefined,
  planetCenter: Vec3Like | null,
  clearance: number,
  samples: number,
  durationMs: number,
): HandoffPath {
  const n = Math.max(1, Math.floor(samples));
  const lift = collisionNudge(from.pos, to.pos, heightAt, planetCenter, clearance, n);
  const positions: Vec3Like[] = new Array(n + 1);
  const lookAts: Vec3Like[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Position = lerp(from.pos, to.pos, t) + lift on the Y axis.
    positions[i] = {
      x: from.pos.x + (to.pos.x - from.pos.x) * t,
      y: from.pos.y + (to.pos.y - from.pos.y) * t + lift,
      z: from.pos.z + (to.pos.z - from.pos.z) * t,
    };
    // Look-at = pos + rotatedForward * LOOK_DISTANCE, where
    // rotatedForward is the slerp of the two look quats.
    const slerped = quatSlerp(fromLookQuat as Quat, toLookQuat as Quat, t);
    const fwd = quatRotateVector(slerped, { x: 0, y: 0, z: 1 });
    const lookDistance = 10; // matches the look-ahead in cockpitPose / onFootPose
    lookAts[i] = {
      x: positions[i].x + fwd.x * lookDistance,
      y: positions[i].y + fwd.y * lookDistance,
      z: positions[i].z + fwd.z * lookDistance,
    };
  }
  return { positions, lookAts, lift, durationMs };
}

/**
 * Sample the precomputed handoff path at the eased progress
 * `t` ∈ [0, 1]. The path's vertices are precomputed at
 * `t = 0, 1/N, 2/N, …, 1`; we apply the cubic ease-in-out to
 * the input `t` and then linearly interpolate the two adjacent
 * samples. This keeps the easing curve identical regardless of
 * the sample count.
 */
export function sampleHandoffPath(path: HandoffPath, t: number): CameraPose {
  const eased = easeInOutCubic(t);
  const n = path.positions.length - 1;
  if (n <= 0 || t <= 0) {
    return { pos: { ...path.positions[0]! }, lookAt: { ...path.lookAts[0]! } };
  }
  if (t >= 1) {
    return { pos: { ...path.positions[n]! }, lookAt: { ...path.lookAts[n]! } };
  }
  const exact = eased * n;
  const idx = Math.min(n - 1, Math.floor(exact));
  const local = exact - idx;
  const aPos = path.positions[idx]!;
  const bPos = path.positions[idx + 1]!;
  const aLook = path.lookAts[idx]!;
  const bLook = path.lookAts[idx + 1]!;
  return {
    pos: {
      x: aPos.x + (bPos.x - aPos.x) * local,
      y: aPos.y + (bPos.y - aPos.y) * local,
      z: aPos.z + (bPos.z - aPos.z) * local,
    },
    lookAt: {
      x: aLook.x + (bLook.x - aLook.x) * local,
      y: aLook.y + (bLook.y - aLook.y) * local,
      z: aLook.z + (bLook.z - aLook.z) * local,
    },
  };
}

/** Convenience: derive the look-direction quats from two poses. */
export function lookQuatsFromPoses(
  from: CameraPose,
  to: CameraPose,
): {
  from: QuatLike;
  to: QuatLike;
} {
  return { from: lookQuatFromPose(from), to: lookQuatFromPose(to) };
}
