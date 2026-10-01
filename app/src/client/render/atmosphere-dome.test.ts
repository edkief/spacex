import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERE_HAZE_COLORS,
  createAtmosphereDome,
  DOME_RADIUS_FACTOR,
} from './atmosphere-dome';

/**
 * TASK-28 step 2: the atmosphere dome — a back-face sphere driven by the
 * single shared haze number. Node object-graph test (no GL): the mesh,
 * material, uniforms, and visibility all follow that one value.
 */
describe('createAtmosphereDome (TASK-28)', () => {
  it('starts hidden (space) with a back-face, transparent, no-depth-write shader', () => {
    const dome = createAtmosphereDome(1000);
    expect(dome.haze).toBe(0);
    expect(dome.mesh.visible).toBe(false);
    const mat = dome.material;
    expect(mat.side).toBe(THREE.BackSide);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.uniforms.uHaze.value).toBe(0);
    dome.dispose();
  });

  it('builds the spec geometry: radius = atmosphereRadius × 1.01', () => {
    const dome = createAtmosphereDome(1000);
    dome.mesh.geometry.computeBoundingSphere();
    const r = dome.mesh.geometry.boundingSphere?.radius ?? -1;
    expect(r).toBeCloseTo(1000 * DOME_RADIUS_FACTOR, 3);
    dome.dispose();
  });

  it('set(haze, color) drives the ONE number: visibility, uHaze, and the tint', () => {
    const dome = createAtmosphereDome(1000);
    const color = new THREE.Color().setRGB(0.5, 0.6, 0.7, THREE.NoColorSpace);
    dome.set(0.5, color);
    expect(dome.haze).toBe(0.5);
    expect(dome.mesh.visible).toBe(true);
    expect(dome.material.uniforms.uHaze.value).toBe(0.5);
    const atmo = dome.material.uniforms.uAtmoColor.value as THREE.Vector3;
    expect(atmo).toEqual(new THREE.Vector3(0.5, 0.6, 0.7));
    // the sky mix-in defaults to the shared skybox average, untouched
    expect(dome.material.uniforms.uSkyColor.value).toBeInstanceOf(THREE.Vector3);

    // haze 0 → hidden again (space: pure skybox, zero cost)
    dome.set(0, color);
    expect(dome.mesh.visible).toBe(false);
    expect(dome.material.uniforms.uHaze.value).toBe(0);
    dome.dispose();
  });

  it('clamps junk haze into [0, 1] (NaN included) and keeps the mesh valid', () => {
    const dome = createAtmosphereDome(1000);
    const color = new THREE.Color(1, 0, 0);
    dome.set(1.5, color);
    expect(dome.haze).toBe(1);
    dome.set(-1, color);
    expect(dome.haze).toBe(0);
    expect(dome.mesh.visible).toBe(false);
    dome.set(Number.NaN, color);
    expect(dome.haze).toBe(0);
    dome.dispose();
  });

  it('exposes a haze tint for every planet class', () => {
    for (const cls of ['rocky', 'terran', 'ocean', 'gas', 'ice'] as const) {
      expect(ATMOSPHERE_HAZE_COLORS[cls]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
