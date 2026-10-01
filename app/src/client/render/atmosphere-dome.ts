import * as THREE from 'three';

import type { PlanetClass } from '@shared/galaxy/types';

/**
 * Atmosphere dome (TASK-28 step 2) — ONE back-face sphere that
 * crossfades the skybox into a planet-colored haze as the player
 * descends through the atmosphere boundary band.
 *
 * The dome is driven by the single shared haze number (the `hazeFactor`
 * in @shared/physics/atmosphere — boundaryFactor × densityScale): the
 * dome's opacity AND the skybox's fade both come from that one value, so
 * the two can never desync (spec: "both driven by the same number").
 * At haze 0 (space) the dome is hidden entirely — zero cost; at haze 1
 * (surface of a full-density planet) it is fully opaque.
 *
 * Fragment model (the whole point, in one line):
 *   color = mix(uSkyColor, uAtmoColor, uHaze), alpha = uHaze
 * so the rendered view is exactly the continuous blend the spec asks
 * for — no pop at any altitude.
 */

/** Dome radius factor: radius = atmosphereRadius × 1.01 (spec). */
export const DOME_RADIUS_FACTOR = 1.01;

/** Planet-class haze tints (the "planet-colored haze" of the spec). */
export const ATMOSPHERE_HAZE_COLORS: Record<PlanetClass, string> = {
  rocky: '#c99a6b',
  terran: '#7fb98a',
  ocean: '#6fa8dc',
  gas: '#d8b078',
  ice: '#bcdcec',
};

/**
 * Sky color mixed into the dome at haze → 0: the average of the shared
 * skybox gradient (bottom #04060b → top #131f33, starfield.ts), so the
 * dome's horizon color matches the sky it replaces.
 */
export const DOME_SKY_COLOR = '#0c131f';

const DOME_VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = /* glsl */ `
uniform float uHaze;
uniform vec3 uSkyColor;
uniform vec3 uAtmoColor;
void main() {
  gl_FragColor = vec4(mix(uSkyColor, uAtmoColor, uHaze), uHaze);
}
`;

/** The dome handle: add `mesh` to a scene, drive it with `set`. */
export interface AtmosphereDome {
  /** Back-face sphere mesh (position it at the planet's surface anchor). */
  mesh: THREE.Mesh;
  /** The shader material (uniforms exposed for probes and tests). */
  material: THREE.ShaderMaterial;
  /** The haze number the dome was last set to (clamped 0..1). */
  readonly haze: number;
  /**
   * Drive the dome from the shared haze number: 0 hides it (space: pure
   * skybox), > 0 shows it with the planet tint mixed in over the sky.
   * Color components are copied into the uniforms verbatim (plain 0..1
   * floats — the shader does no color-space math of its own).
   */
  set(haze: number, atmoColor: THREE.Color, skyColor?: THREE.Color): void;
  dispose(): void;
}

/**
 * Build the dome for an atmosphere enter radius (world u). The geometry
 * is radius × DOME_RADIUS_FACTOR per the spec (per-planet geometry; at
 * most one dome is active at a time — the nearest planet).
 */
export function createAtmosphereDome(radiusU: number): AtmosphereDome {
  const geometry = new THREE.SphereGeometry(radiusU * DOME_RADIUS_FACTOR, 48, 28);
  const material = new THREE.ShaderMaterial({
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    uniforms: {
      uHaze: { value: 0 },
      uSkyColor: { value: new THREE.Vector3() },
      uAtmoColor: { value: new THREE.Vector3() },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  {
    const n = parseInt(DOME_SKY_COLOR.slice(1), 16);
    (material.uniforms.uSkyColor.value as THREE.Vector3).set(
      ((n >> 16) & 0xff) / 255,
      ((n >> 8) & 0xff) / 255,
      (n & 0xff) / 255,
    );
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false; // space by default — the dome never renders for free
  // The skybox sphere also depth-writes nothing; keep the dome after the
  // sky in the transparent pass so its alpha composites OVER the sky.
  mesh.renderOrder = 1;

  let haze = 0;
  return {
    mesh,
    material,
    get haze(): number {
      return haze;
    },
    set(h: number, atmoColor: THREE.Color, skyColor?: THREE.Color): void {
      haze = THREE.MathUtils.clamp(Number.isFinite(h) ? h : 0, 0, 1);
      material.uniforms.uHaze.value = haze;
      const atmo = material.uniforms.uAtmoColor.value as THREE.Vector3;
      atmo.set(atmoColor.r, atmoColor.g, atmoColor.b);
      if (skyColor) {
        const sky = material.uniforms.uSkyColor.value as THREE.Vector3;
        sky.set(skyColor.r, skyColor.g, skyColor.b);
      }
      mesh.visible = haze > 1e-4;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
