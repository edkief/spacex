import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createSun, SUN_ANGULAR_RADIUS_DEG, SUN_DIRECTION, SUN_DISTANCE, sunPosition } from './sun';
import { vecLength, vecSub, type Vec3 } from '@shared/physics/vec';

/**
 * TASK-82: the pure sun-placement math. three.js geometry is never rendered
 * here (headless) — the direction / distance / camera-relative position are
 * the testable contract; a small structural check covers the mesh.
 */

describe('sun placement (TASK-82)', () => {
  it('SUN_DIRECTION is a unit vector pointing toward −X with positive y and z = 0', () => {
    expect(vecLength(SUN_DIRECTION)).toBeCloseTo(1, 9);
    expect(SUN_DIRECTION.x).toBeLessThan(0);
    expect(SUN_DIRECTION.y).toBeGreaterThan(0);
    expect(SUN_DIRECTION.z).toBe(0);
  });

  it('the sun sits SUN_DISTANCE from the origin, inside the 420 u sky shell', () => {
    expect(SUN_DISTANCE).toBeLessThan(420);
    expect(vecLength(sunPosition({ x: 0, y: 0, z: 0 }))).toBeCloseTo(SUN_DISTANCE, 9);
  });

  it('sunPosition is camera-relative: moving the camera by D moves the sun by exactly D', () => {
    const camA: Vec3 = { x: 12.5, y: -30, z: 400 };
    const camB: Vec3 = { x: 1000.5, y: 80, z: -250 };
    const d = vecSub(camB, camA);
    const moved = vecSub(sunPosition(camB), sunPosition(camA));
    expect(Math.hypot(moved.x - d.x, moved.y - d.y, moved.z - d.z)).toBeLessThan(1e-6);
  });

  it('the angular radius yields a finite, positive disc radius (d × tan θ)', () => {
    expect(SUN_ANGULAR_RADIUS_DEG).toBeGreaterThan(0);
    const r = SUN_DISTANCE * Math.tan((SUN_ANGULAR_RADIUS_DEG * Math.PI) / 180);
    expect(r).toBeGreaterThan(0);
    expect(Number.isFinite(r)).toBe(true);
  });
});

describe('createSun (TASK-82)', () => {
  it('builds an unlit sphere, renderOrder 1, tinted by the given colour', () => {
    const sun = createSun('#fff4e8');
    expect(sun.mesh).toBeInstanceOf(THREE.Mesh);
    expect(sun.mesh.renderOrder).toBe(1);
    const mat = sun.mesh.material as THREE.MeshBasicMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.fog).toBe(false);
    // The disc radius is SUN_DISTANCE × tan(2°) — the sphere geometry matches.
    const radius = SUN_DISTANCE * Math.tan((SUN_ANGULAR_RADIUS_DEG * Math.PI) / 180);
    const geo = sun.mesh.geometry;
    geo.computeBoundingSphere();
    expect(geo.boundingSphere?.radius).toBeCloseTo(radius, 5);
    expect(() => sun.dispose()).not.toThrow();
  });

  it('setOpacity and setColor update the material', () => {
    const sun = createSun('#ffffff');
    sun.setOpacity(0.42);
    expect((sun.mesh.material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(0.42, 9);
    sun.setColor('#ffcc6f');
    expect((sun.mesh.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xffcc6f);
    sun.dispose();
  });
});
