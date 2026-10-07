import * as THREE from 'three';
import { vecAdd, vecNormalize, vecScale, type Vec3 } from '@shared/physics/vec';

/**
 * TASK-82: the system star rendered as a distant SUN — effectively infinitely
 * far, in a fixed direction, exactly like the skybox (which TASK-75 re-centres
 * on the camera every frame).
 *
 * The sim is 1 u = 1 m and the RENDERED world must match it. The sim's star
 * sits at the origin and every planet anchor lies along +X
 * (`planetAnchor(i) = ((i + 1) × 10 000, 0, 0)`), so from anywhere in the
 * system the star is toward −X. The spawn gate (100 u +X) faces −X, so a
 * warped-in ship looks straight at the sun. A small +Y keeps the sun above the
 * y = 0 horizon (it would otherwise sit on the ground plane the planets sit on).
 *
 * Replaces the old ~130 m miniature orrery (a 14 m star ball at the origin)
 * that no longer exists: a ship at 120 u/s crossed the whole "system" in a
 * second. TASK-83 draws the planets where the sim has them.
 */

/** Unit direction from anywhere in the system toward the star (−X, slightly up). */
export const SUN_DIRECTION: Vec3 = vecNormalize({ x: -1, y: 0.12, z: 0 });

/**
 * Distance from the camera to the sun (u). Chosen INSIDE the sky shell
 * (SKY_RADIUS, starfield.ts) so the sun composites OVER the skybox (TASK-75
 * keeps both camera-centred, so the sun can never be left behind). The 2°
 * angular radius at this distance is the on-screen disc size.
 */
export const SUN_DISTANCE = 380;

/** The sun's angular radius in degrees (the on-screen disc it subtends). */
export const SUN_ANGULAR_RADIUS_DEG = 2;

/**
 * Pure: the sun's world position for a camera at `cameraPos`. Always
 * SUN_DISTANCE along SUN_DIRECTION — so the sun is effectively infinitely far:
 * moving the camera by exactly D moves the sun by exactly D (no parallax).
 */
export function sunPosition(cameraPos: Vec3): Vec3 {
  return vecAdd(cameraPos, vecScale(SUN_DIRECTION, SUN_DISTANCE));
}

/** The handle WorldManager keeps for the scene-level sun mesh. */
export interface SunHandle {
  /** The sun sphere (the caller adds it to the scene AFTER the stars). */
  mesh: THREE.Mesh;
  /** Scale the sun's opacity (driven by the shared atmosphere fade). */
  setOpacity(o: number): void;
  /** Re-tint the disc (a warp into a new system → new spectral-class colour). */
  setColor(color: string): void;
  dispose(): void;
}

/**
 * Build the sun: a small UNLIT sphere sized so it subtends
 * SUN_ANGULAR_RADIUS_DEG at SUN_DISTANCE (radius = SUN_DISTANCE × tan(θ)),
 * in the given star colour. `transparent` + `depthWrite:false` + renderOrder 1
 * so it composites OVER the sky (renderOrder 0) and the stars (renderOrder 1,
 * added earlier — the higher object id wins the tie, so the sun draws last).
 * One draw call (no glow — kept cheap, ≤ 2 draw calls by design).
 */
export function createSun(color: string): SunHandle {
  const radius = SUN_DISTANCE * Math.tan((SUN_ANGULAR_RADIUS_DEG * Math.PI) / 180);
  const geometry = new THREE.SphereGeometry(radius, 24, 16);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  return {
    mesh,
    setOpacity(o: number): void {
      material.opacity = o;
    },
    setColor(color: string): void {
      material.color.set(color);
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
