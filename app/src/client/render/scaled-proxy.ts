/**
 * TASK-83: pure scaled-proxy math — the standard technique for rendering an
 * object farther away than the camera's far plane without changing where it
 * appears: beyond a threshold distance, draw it at a FIXED distance along
 * the TRUE camera→object direction, scaled down by the same ratio. The
 * on-screen position and the angular size are then EXACT (same ray, same
 * radius/distance ratio) while the object stays inside the depth range.
 *
 * The planet islands live 10–60 km from the camera but CAMERA_FAR is only
 * 4000 m (TASK-76), so every planet beyond PROXY_START_M renders as a
 * proxy (see planet-bodies.ts for the per-frame application).
 */

import {
  vecAdd,
  vecLength,
  vecNormalize,
  vecScale,
  vecSub,
  type Vec3,
} from '@shared/physics/vec';

/**
 * Distance (m) at which the proxy kicks in. Both constants sit INSIDE
 * CAMERA_FAR (4000, WorldManager.ts): at PROXY_START_M the object is drawn
 * at its true position/scale (the identity branch below), and beyond it the
 * proxy is pulled back to PROXY_DISTANCE_M — always < CAMERA_FAR, so a proxy
 * can never be clipped by the far plane. The transform is continuous at the
 * threshold (scale → 1 as distance → PROXY_START_M), so nothing pops.
 */
export const PROXY_START_M = 3_000;
/** Fixed camera→proxy distance (m) every far object is drawn at. */
export const PROXY_DISTANCE_M = 3_000;

/** The proxy placement: where to draw the object and at what uniform scale. */
export interface ProxyTransform {
  /** World position to draw the object at (camera + dir × PROXY_DISTANCE_M). */
  pos: Vec3;
  /** Uniform scale (1 at true position; PROXY_DISTANCE_M / distance far away). */
  scale: number;
}

/**
 * Pure: the scaled-proxy placement of a world object for a camera at
 * `cameraPos`. Within PROXY_START_M the object is unchanged ({ pos:
 * worldPos, scale: 1 }); beyond it, pos = cameraPos + dir × PROXY_DISTANCE_M
 * and scale = PROXY_DISTANCE_M / distance, where dir is the exact
 * camera→world direction.
 */
export function proxyTransform(cameraPos: Vec3, worldPos: Vec3): ProxyTransform {
  const toObject = vecSub(worldPos, cameraPos);
  const distance = vecLength(toObject);
  if (distance <= PROXY_START_M) {
    return { pos: worldPos, scale: 1 };
  }
  const scale = PROXY_DISTANCE_M / distance;
  const dir = vecNormalize(toObject);
  return { pos: vecAdd(cameraPos, vecScale(dir, PROXY_DISTANCE_M)), scale };
}
