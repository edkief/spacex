/**
 * TASK-50: the target box's world→NDC→screen projection, as PURE math so it
 * is unit-testable without a GL context. The live path (TargetBox) runs this
 * once per rAF frame and writes the result to a ref'd style — the only
 * per-frame HUD work (no React re-render).
 *
 * Convention: the camera's VIEW FORWARD is the local -Z axis (three.js), so
 * the forward basis vector is the quat rotated (0, 0, -1). A target is
 * "behind the camera" when dot(forward, toTarget) < 0 (the camera-plane
 * test — NDC z > 1 is an equivalent clip-space formulation).
 */
import type { Quat, Vec3 } from '@shared/physics/vec';
import { quatRotateVector, vecDot, vecSub } from '@shared/physics/vec';

/** Everything the projection needs, sampled once per frame. */
export interface CameraSample {
  pos: Vec3;
  quat: Quat;
  /** Vertical field of view (degrees, the PerspectiveCamera fov). */
  fovDeg: number;
  /** CSS pixels (viewport size). */
  width: number;
  height: number;
}

/** Unit camera basis (view direction = -Z, right = +X, up = +Y). */
export interface CameraBasis {
  pos: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export function cameraBasisFromSample(sample: CameraSample): CameraBasis {
  return {
    pos: sample.pos,
    forward: quatRotateVector(sample.quat, { x: 0, y: 0, z: -1 }),
    right: quatRotateVector(sample.quat, { x: 1, y: 0, z: 0 }),
    up: quatRotateVector(sample.quat, { x: 0, y: 1, z: 0 }),
  };
}

/** True when the target sits behind the camera plane (hide the box). */
export function isBehindCamera(world: Vec3, basis: CameraBasis): boolean {
  return vecDot(basis.forward, vecSub(world, basis.pos)) < 0;
}

/**
 * Project a world position to CSS pixels (origin top-left). Null when the
 * point is behind the camera plane. NDC y is flipped for screen space.
 */
export function projectWorldToScreen(
  world: Vec3,
  sample: CameraSample,
): { x: number; y: number } | null {
  const basis = cameraBasisFromSample(sample);
  const to = vecSub(world, basis.pos);
  const depth = vecDot(basis.forward, to);
  // Behind the camera plane — or exactly ON it (degenerate, hides too).
  if (depth <= 0) return null;
  const tanHalf = Math.tan(((sample.fovDeg / 2) * Math.PI) / 180);
  const aspect = sample.width / sample.height;
  const ndcX = vecDot(basis.right, to) / depth / tanHalf / aspect;
  const ndcY = vecDot(basis.up, to) / depth / tanHalf;
  return {
    x: ((ndcX + 1) / 2) * sample.width,
    y: ((1 - ndcY) / 2) * sample.height,
  };
}
