/**
 * Target-box world → screen projection — TASK-50.
 *
 * Pure math, no DOM and no three.js, so the unit suite can run the
 * exact same code the `TargetBox` rAF driver runs.
 *
 * Camera convention (matches `camera/cameraMath.ts`): right-handed,
 * +Y up, the camera looks down its local `+Z` (`forward`).
 *
 * Hide rules (spec):
 *   - **Behind camera** — `dot(cameraForward, toTarget) <= 0`.
 *   - **Too far** — `distance > TARGET_BOX_MAX_RANGE_M` (1500 m,
 *     the same constant the server auto-releases at).
 *   - **Off screen** — the projected NDC point falls outside the
 *     viewport (with a small margin so a target hugging the edge
 *     still shows a sliver of bracket).
 */

import type { Vec3Like } from "../../camera/types.js";

/** Beyond this range the box hides (spec: > 1500 m). */
export const TARGET_BOX_MAX_RANGE_M = 1500;

/**
 * View-space depth gate. Anything at or behind this depth is
 * "behind the camera" — a hair of slack keeps the box from
 * flickering at the exact 90° edge of the frustum.
 */
export const TARGET_BOX_MIN_DEPTH_M = 0.1;

/** NDC slack so a target just off the edge still renders. */
export const TARGET_BOX_NDC_MARGIN = 0.08;

/** Default vertical FOV (matches `cameraMath.FOV_DEG`). */
export const TARGET_BOX_DEFAULT_FOV_DEG = 75;

/** Why the box is not drawn (or `null` when it is). */
export type TargetBoxHideReason = "behind-camera" | "too-far" | "off-screen" | "no-lock";

/** Result of one projection pass. */
export interface TargetScreenProjection {
  /** Screen-space centre in CSS pixels (viewport origin top-left). */
  readonly x: number;
  readonly y: number;
  /** Straight-line range to the target in metres. */
  readonly distanceM: number;
  /** True when the box should be drawn. */
  readonly visible: boolean;
  /** Populated when `visible` is false. */
  readonly hidden: TargetBoxHideReason | null;
}

/** Inputs for one projection pass. */
export interface TargetProjectionInput {
  /** Camera world position. */
  camPos: Vec3Like;
  /** Camera forward (unit). */
  camForward: Vec3Like;
  /** Target world position. */
  targetPos: Vec3Like;
  /** Viewport size in CSS pixels. */
  viewportW: number;
  viewportH: number;
  /** Vertical FOV in degrees (default 75). */
  fovDeg?: number;
}

/** Normalise a vector; returns `null` for degenerate input. */
function normalize(v: Vec3Like): Vec3Like | null {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (!Number.isFinite(len) || len < 1e-9) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Cross product of two 3-vectors.
 */
function cross(a: Vec3Like, b: Vec3Like): Vec3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Dot product of two 3-vectors. */
function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Project a world point to screen pixels behind the given camera.
 *
 * Returns a fully-formed projection even when the target is hidden
 * so the caller can render debug telemetry without a second
 * projection pass. Non-finite input is treated as "no lock" rather
 * than producing `NaN` styles.
 */
export function projectTargetToScreen(input: TargetProjectionInput): TargetScreenProjection {
  const { camPos, camForward, targetPos, viewportW, viewportH } = input;
  const fovDeg = input.fovDeg ?? TARGET_BOX_DEFAULT_FOV_DEG;
  const finite =
    Number.isFinite(camPos.x) &&
    Number.isFinite(camPos.y) &&
    Number.isFinite(camPos.z) &&
    Number.isFinite(camForward.x) &&
    Number.isFinite(camForward.y) &&
    Number.isFinite(camForward.z) &&
    Number.isFinite(targetPos.x) &&
    Number.isFinite(targetPos.y) &&
    Number.isFinite(targetPos.z) &&
    viewportW > 0 &&
    viewportH > 0;
  if (!finite) return { x: 0, y: 0, distanceM: 0, visible: false, hidden: "no-lock" };

  const forward = normalize(camForward);
  if (forward === null) return { x: 0, y: 0, distanceM: 0, visible: false, hidden: "no-lock" };

  const toTarget: Vec3Like = {
    x: targetPos.x - camPos.x,
    y: targetPos.y - camPos.y,
    z: targetPos.z - camPos.z,
  };
  const distanceM = Math.sqrt(dot(toTarget, toTarget));

  // Hide rule — out of range first (cheapest + most common).
  if (distanceM > TARGET_BOX_MAX_RANGE_M) {
    return { x: 0, y: 0, distanceM, visible: false, hidden: "too-far" };
  }

  // View space: depth along forward; right = worldUp × forward
  // (right-handed: +Z forward, +Y up → +X right).
  const depth = dot(toTarget, forward);
  if (depth <= TARGET_BOX_MIN_DEPTH_M) {
    return { x: 0, y: 0, distanceM, visible: false, hidden: "behind-camera" };
  }
  const rightRaw = cross({ x: 0, y: 1, z: 0 }, forward);
  const right = normalize(rightRaw) ?? { x: 1, y: 0, z: 0 };
  const up = normalize(cross(forward, right)) ?? { x: 0, y: 1, z: 0 };
  const vx = dot(toTarget, right);
  const vy = dot(toTarget, up);

  const tanHalfFov = Math.tan((fovDeg * Math.PI) / 180 / 2);
  const aspect = viewportW / viewportH;
  const tanHalfH = tanHalfFov * aspect;
  if (tanHalfFov <= 0 || tanHalfH <= 0) {
    return { x: 0, y: 0, distanceM, visible: false, hidden: "no-lock" };
  }
  const ndcX = vx / (depth * tanHalfH);
  const ndcY = vy / (depth * tanHalfFov);
  const x = (ndcX * 0.5 + 0.5) * viewportW;
  const y = (0.5 - ndcY * 0.5) * viewportH;

  const offScreen =
    ndcX < -1 - TARGET_BOX_NDC_MARGIN ||
    ndcX > 1 + TARGET_BOX_NDC_MARGIN ||
    ndcY < -1 - TARGET_BOX_NDC_MARGIN ||
    ndcY > 1 + TARGET_BOX_NDC_MARGIN;
  return {
    x,
    y,
    distanceM,
    visible: !offScreen,
    hidden: offScreen ? "off-screen" : null,
  };
}

/**
 * Ratio clamp for the hull / shield bars. `value` is clamped to
 * `[0, max]` and a non-positive / non-finite `max` reads as 0 so
 * the bar never renders wider than its track.
 */
export function barRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  if (value <= 0) return 0;
  return Math.min(1, value / max);
}
