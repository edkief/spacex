/**
 * TASK-50: the target-box projection math (world→NDC→screen, behind-camera
 * hide). The conventions are checked CONVENTION-INDEPENDENTLY: the expected
 * forward comes from the basis itself, so a test cannot pass while the
 * camera basis and the projection disagree.
 */
import { describe, expect, it } from 'vitest';
import { quatFromEuler, quatIdentity } from '@shared/physics/vec';
import {
  cameraBasisFromSample,
  isBehindCamera,
  projectWorldToScreen,
  type CameraSample,
} from './projection';

function sample(overrides: Partial<CameraSample> = {}): CameraSample {
  return {
    pos: { x: 0, y: 0, z: 0 },
    quat: quatIdentity(),
    fovDeg: 90,
    width: 1_000,
    height: 1_000,
    ...overrides,
  };
}

describe('camera basis', () => {
  it('identity quat: forward -Z, right +X, up +Y (three.js convention)', () => {
    const b = cameraBasisFromSample(sample());
    expect(b.forward).toEqual({ x: 0, y: 0, z: -1 });
    expect(b.right).toEqual({ x: 1, y: 0, z: 0 });
    expect(b.up).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('a yawed quat rotates the basis (forward = quat * (0,0,-1))', () => {
    const q = quatFromEuler(Math.PI / 2, 0, 0);
    const b = cameraBasisFromSample(sample({ quat: q }));
    const fx = Math.round(b.forward.x * 1e9) / 1e9;
    const fz = Math.round(b.forward.z * 1e9) / 1e9;
    // Yaw 90° about +Y maps -Z to ∓X — either sign is a valid right-handed
    // choice; the point is that forward is HORIZONTAL and unit-length.
    expect(Math.abs(fx)).toBeCloseTo(1, 6);
    expect(Math.abs(fz)).toBeCloseTo(0, 6);
    expect(b.forward.y).toBeCloseTo(0, 6);
    expect(Math.hypot(b.forward.x, b.forward.y, b.forward.z)).toBeCloseTo(1, 6);
  });
});

describe('isBehindCamera', () => {
  const b = cameraBasisFromSample(sample());
  it('dot(forward, toTarget) < 0 is behind', () => {
    expect(isBehindCamera({ x: 0, y: 0, z: 100 }, b)).toBe(true);
    expect(isBehindCamera({ x: 0, y: 0, z: -100 }, b)).toBe(false);
    expect(isBehindCamera({ x: 10, y: 0, z: -5 }, b)).toBe(false);
  });
});

describe('projectWorldToScreen', () => {
  it('a point dead ahead projects to screen center', () => {
    expect(projectWorldToScreen({ x: 0, y: 0, z: -100 }, sample())).toEqual({
      x: 500,
      y: 500,
    });
  });

  it('90° fov / aspect 1: one fov unit right at the same depth is the right edge', () => {
    const p = projectWorldToScreen({ x: 100, y: 0, z: -100 }, sample());
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(1_000, 6);
    expect(p!.y).toBeCloseTo(500, 6);
  });

  it('a point UP projects toward the top of the screen (NDC y flip)', () => {
    const p = projectWorldToScreen({ x: 0, y: 100, z: -100 }, sample());
    expect(p!.y).toBeCloseTo(0, 6);
  });

  it('a narrower fov magnifies the offset (1/tan(fov/2))', () => {
    const wide = projectWorldToScreen({ x: 50, y: 0, z: -100 }, sample({ fovDeg: 90 }));
    const narrow = projectWorldToScreen({ x: 50, y: 0, z: -100 }, sample({ fovDeg: 45 }));
    // offset = (x/depth) / tan(fov/2) / aspect × width/2
    expect(wide!.x - 500).toBeCloseTo((0.5 / Math.tan(Math.PI / 4)) * 500, 3);
    expect(narrow!.x - 500).toBeCloseTo((0.5 / Math.tan(Math.PI / 8)) * 500, 3);
  });

  it('a wider screen (aspect 2) keeps the same pixel offset (horizontal fov widens)', () => {
    const p1 = projectWorldToScreen({ x: 50, y: 0, z: -100 }, sample());
    const p2 = projectWorldToScreen(
      { x: 50, y: 0, z: -100 },
      sample({ width: 2_000, height: 1_000 }),
    );
    expect(p1!.x - 500).toBeCloseTo(250, 3);
    expect(p2!.x - 1_000).toBeCloseTo(p1!.x - 500, 3);
  });

  it('behind the camera → null (hide the box)', () => {
    expect(projectWorldToScreen({ x: 0, y: 0, z: 100 }, sample())).toBeNull();
  });

  it('exactly on the camera plane → null (degenerate)', () => {
    expect(projectWorldToScreen({ x: 5, y: 0, z: 0 }, sample())).toBeNull();
  });

  it('follows a moved camera (position offset)', () => {
    const s = sample({ pos: { x: 0, y: 0, z: 100 } });
    expect(projectWorldToScreen({ x: 0, y: 0, z: 0 }, s)).toEqual({ x: 500, y: 500 });
  });

  it('a yawed camera: the point dead ahead of IT is centered', () => {
    const q = quatFromEuler(Math.PI / 2, 0, 0);
    const b = cameraBasisFromSample(sample({ quat: q }));
    const ahead = {
      x: b.forward.x * 100,
      y: b.forward.y * 100,
      z: b.forward.z * 100,
    };
    const p = projectWorldToScreen(ahead, sample({ quat: q }));
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(500, 3);
    expect(p!.y).toBeCloseTo(500, 3);
  });
});
