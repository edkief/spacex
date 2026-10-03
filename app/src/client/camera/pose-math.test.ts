/**
 * TASK-27 step 3 (unit): the pure handoff math — pose construction, lerp,
 * slerp, ease curve, pitch clamp, and the terrain-nudge path against an
 * analytic mesa. No DOM, no WebGL: shared/physics/vec ops only.
 */

import { describe, expect, it } from 'vitest';

import { quatFromEuler, quatIdentity, quatRotateVector, type Vec3 } from '@shared/physics/vec';
import { SPAWN_GATE_QUAT } from '@shared/galaxy/spawn';

import {
  CHASE_BEHIND,
  CHASE_HEIGHT,
  CHASE_LOOK_AHEAD,
  chasePose,
  clampPitchDeg,
  clampPitchRad,
  cockpitPose,
  computeHandoffPath,
  easeInOutCubic,
  FLAT_GROUND,
  HANDOFF_CLEARANCE_M,
  HANDOFF_SAMPLES,
  lerpPose,
  nudgeOutOfTerrain,
  onFootPose,
  samplePath,
  slerpVec,
  type Pose,
} from './pose-math';

const DEG = 180 / Math.PI;
const YAW_90 = quatFromEuler(Math.PI / 2, 0, 0);

const pose = (px: number, py: number, pz: number, lx: number, ly: number, lz: number): Pose => ({
  position: { x: px, y: py, z: pz },
  look: { x: lx, y: ly, z: lz },
});

/** Analytic mesa: height 6 within radius 5 of (0, 8). */
const mesa = (x: number, z: number): number => (Math.hypot(x, z - 8) <= 5 ? 6 : 0);

describe('pose construction', () => {
  it('cockpit: ship-local offset (0, 0.5, 1.2) at identity quat', () => {
    const p = cockpitPose({ pos: { x: 0, y: 0, z: 0 }, quat: quatIdentity() });
    expect(p.position).toEqual({ x: 0, y: 0.5, z: 1.2 });
    // Looking along the ship forward (+Z), from the cockpit height.
    expect(p.look.x).toBeCloseTo(0);
    expect(p.look.y).toBeCloseTo(0.5);
    expect(p.look.z).toBeGreaterThan(1.2);
  });

  it('cockpit: offset rotates with the ship quat (90° yaw)', () => {
    const ship = { pos: { x: 5, y: 7, z: 2 }, quat: YAW_90 };
    const p = cockpitPose(ship);
    // +Z forward becomes +X under a 90° yaw: offset (0, 0.5, 1.2) → (1.2, 0.5, 0)
    expect(p.position.x).toBeCloseTo(5 + 1.2);
    expect(p.position.y).toBeCloseTo(7 + 0.5);
    expect(p.position.z).toBeCloseTo(2);
    // Look keeps tracking the rotated forward.
    expect(p.look.x).toBeGreaterThan(p.position.x + 10);
  });

  it('chase: behind + above the ship for an identity-quat ship', () => {
    const p = chasePose({ pos: { x: 3, y: 1, z: -2 }, quat: quatIdentity() });
    // Forward is +Z, so behind is -Z: (3, 1+4, -2-14).
    expect(p.position).toEqual({ x: 3, y: 1 + CHASE_HEIGHT, z: -2 - CHASE_BEHIND });
    // Looking CHASE_LOOK_AHEAD ahead along the ship forward (+Z).
    expect(p.look).toEqual({ x: 3, y: 1, z: -2 + CHASE_LOOK_AHEAD });
  });

  it('chase: offset + look rotate with the ship quat (SPAWN_GATE_QUAT)', () => {
    const pos = { x: 100, y: 0, z: 50 };
    const q = SPAWN_GATE_QUAT;
    const p = chasePose({ pos, quat: q });
    const rotOffset = quatRotateVector(q, { x: 0, y: CHASE_HEIGHT, z: -CHASE_BEHIND });
    const rotAhead = quatRotateVector(q, { x: 0, y: 0, z: CHASE_LOOK_AHEAD });
    expect(p.position.x).toBeCloseTo(pos.x + rotOffset.x, 10);
    expect(p.position.y).toBeCloseTo(pos.y + rotOffset.y, 10);
    expect(p.position.z).toBeCloseTo(pos.z + rotOffset.z, 10);
    expect(p.look.x).toBeCloseTo(pos.x + rotAhead.x, 10);
    expect(p.look.y).toBeCloseTo(pos.y + rotAhead.y, 10);
    expect(p.look.z).toBeCloseTo(pos.z + rotAhead.z, 10);
  });

  it('chase: follows yaw (90° → the camera orbits to the -X side of the ship)', () => {
    const q = quatFromEuler(Math.PI / 2, 0, 0);
    const p = chasePose({ pos: { x: 0, y: 0, z: 0 }, quat: q });
    // +Z forward becomes +X under 90° yaw: behind (-Z local) becomes -X world.
    expect(p.position.x).toBeCloseTo(-CHASE_BEHIND);
    expect(p.position.y).toBeCloseTo(CHASE_HEIGHT);
    expect(p.position.z).toBeCloseTo(0);
    expect(p.look.x).toBeCloseTo(CHASE_LOOK_AHEAD);
    expect(p.look.z).toBeCloseTo(0);
  });

  it('on-foot: 4 m behind the character, 1.6 m up, looking at the head', () => {
    const p = onFootPose({ pos: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 0 });
    const head: Vec3 = { x: 1, y: 3.6, z: 3 };
    expect(p.look).toEqual(head);
    expect(p.position.x).toBeCloseTo(1);
    expect(p.position.y).toBeCloseTo(3.6);
    expect(p.position.z).toBeCloseTo(3 - 4);
  });

  it('on-foot: yaw rotates the behind-offset (90° → -X side)', () => {
    const p = onFootPose({ pos: { x: 0, y: 0, z: 0 }, yaw: Math.PI / 2, pitch: 0 });
    // Character looks +X → camera sits 4 m along -X, at head height.
    expect(p.position.x).toBeCloseTo(-4);
    expect(p.position.y).toBeCloseTo(1.6);
    expect(p.position.z).toBeCloseTo(0);
  });
});

describe('lerpPose', () => {
  const a = pose(0, 0, 0, 0, 0, 10);
  const b = pose(10, 20, 30, 10, 20, 40);

  it('t = 0 / 1 return the endpoints; t = 0.5 the midpoint', () => {
    expect(lerpPose(a, b, 0)).toEqual(a);
    expect(lerpPose(a, b, 1)).toEqual(b);
    const mid = lerpPose(a, b, 0.5);
    expect(mid.position).toEqual({ x: 5, y: 10, z: 15 });
    expect(mid.look).toEqual({ x: 5, y: 10, z: 25 });
  });

  it('clamps t outside [0, 1]', () => {
    expect(lerpPose(a, b, -0.5)).toEqual(a);
    expect(lerpPose(a, b, 1.5)).toEqual(b);
  });
});

describe('slerpVec', () => {
  it('interpolates the short arc (90° at t = 0.5 → diagonal)', () => {
    const r = slerpVec({ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, 0.5);
    expect(r.x).toBeCloseTo(Math.SQRT1_2);
    expect(r.z).toBeCloseTo(Math.SQRT1_2);
  });

  it('returns endpoints at t = 0 / 1, flips antipodal input', () => {
    const a = { x: 1, y: 0, z: 0 };
    expect(slerpVec(a, { x: -1, y: 0, z: 0 }, 0.5)).toEqual(a);
    expect(slerpVec(a, { x: 0, y: 0, z: 1 }, 0)).toEqual(a);
    expect(slerpVec(a, { x: 0, y: 0, z: 1 }, 1)).toEqual({ x: 0, y: 0, z: 1 });
  });
});

describe('easeInOutCubic', () => {
  it('anchors and symmetry', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(0.25)).toBeCloseTo(0.0625);
    expect(easeInOutCubic(0.75)).toBeCloseTo(0.9375);
  });

  it('clamps outside [0, 1]', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
});

describe('pitch clamp', () => {
  it('clamps degrees to ±80', () => {
    expect(clampPitchDeg(95)).toBe(80);
    expect(clampPitchDeg(-100)).toBe(-80);
    expect(clampPitchDeg(30)).toBe(30);
    expect(clampPitchDeg(80)).toBe(80);
    expect(clampPitchDeg(-80)).toBe(-80);
  });

  it('clamps radians to ±80°', () => {
    expect(clampPitchRad(Math.PI / 2) * DEG).toBeCloseTo(80);
    expect(clampPitchRad(-2) * DEG).toBeCloseTo(-80);
    expect(clampPitchRad(0.5) * DEG).toBeCloseTo(0.5 * DEG);
  });
});

describe('terrain nudge', () => {
  it('lifts a pose below heightAt + clearance; leaves a clear pose alone', () => {
    const low = pose(0, 2, 8, 0, 2, 18); // inside the mesa (h = 6)
    const nudged = nudgeOutOfTerrain(low, mesa);
    expect(nudged.position.y).toBeCloseTo(6 + HANDOFF_CLEARANCE_M);
    expect(nudged.position.x).toBe(0); // x/z untouched
    expect(nudged.position.z).toBe(8);
    const clear = pose(0, 50, 0, 0, 50, 10); // above everything
    expect(nudgeOutOfTerrain(clear, mesa)).toEqual(clear);
  });

  it('computeHandoffPath: 5 samples, exact endpoints, x/z stay on the lerp line', () => {
    const from = pose(0, 10.5, 1.2, 0, 10.5, 11.2); // settled cockpit
    const to = pose(0, 1.6, 16, 0, 1.6, 20); // on-foot over the mesa
    const path = computeHandoffPath(from, to, mesa);
    expect(path).toHaveLength(HANDOFF_SAMPLES);
    // t = 1 lerp hits the endpoint up to fp noise.
    for (const k of ['x', 'y', 'z'] as const) {
      expect(path[0].position[k]).toBeCloseTo(from.position[k], 12);
      expect(path[4].position[k]).toBeCloseTo(to.position[k], 12);
    }
    for (const p of path) {
      expect(p.position.x).toBeCloseTo(0);
      // y never enters the geometry
      expect(p.position.y).toBeGreaterThanOrEqual(
        mesa(p.position.x, p.position.z) + HANDOFF_CLEARANCE_M - 1e-6,
      );
    }
  });

  it('computeHandoffPath: the straight path dipping into the mesa gets exactly the dipping samples lifted', () => {
    const from = pose(0, 10.5, 1.2, 0, 10.5, 11.2);
    const to = pose(0, 1.6, 16, 0, 1.6, 20);
    const path = computeHandoffPath(from, to, mesa);
    let nudges = 0;
    for (let i = 0; i < path.length; i++) {
      const t = i / (path.length - 1);
      const rawY = from.position.y + (to.position.y - from.position.y) * t;
      if (Math.abs(path[i].position.y - rawY) > 1e-9) nudges += 1;
    }
    // t = 0.25 sits at y 8.275 (clear of the 7.5 line); 0.5 and 0.75 dip
    // into the mesa and are lifted; the endpoints are exact.
    expect(nudges).toBe(2);
    expect(path[1].position.y).toBeCloseTo(10.5 + (1.6 - 10.5) * 0.25);
    expect(path[2].position.y).toBeCloseTo(6 + HANDOFF_CLEARANCE_M);
    expect(path[3].position.y).toBeCloseTo(6 + HANDOFF_CLEARANCE_M);
  });

  it('computeHandoffPath on flat ground: a pure lerp (no nudge)', () => {
    const from = pose(0, 10, 0, 0, 10, 10);
    const to = pose(0, 2, 20, 0, 2, 30);
    const path = computeHandoffPath(from, to, FLAT_GROUND);
    for (let i = 0; i < path.length; i++) {
      const t = i / (path.length - 1);
      expect(path[i].position.y).toBeCloseTo(10 + (2 - 10) * t);
    }
  });
});

describe('samplePath', () => {
  const path = [
    pose(0, 0, 0, 0, 0, 10),
    pose(1, 1, 1, 1, 1, 11),
    pose(2, 2, 2, 2, 2, 12),
    pose(3, 3, 3, 3, 3, 13),
    pose(4, 4, 4, 4, 4, 14),
  ];

  it('e = 0 / 1 hit the endpoints; e = 0.5 the middle sample', () => {
    expect(samplePath(path, 0).position).toEqual(path[0].position);
    expect(samplePath(path, 1).position).toEqual(path[4].position);
    expect(samplePath(path, 0.5).position).toEqual(path[2].position);
  });

  it('interpolates between stored samples (e = 0.625 → halfway 2→3)', () => {
    const p = samplePath(path, 0.625);
    expect(p.position.x).toBeCloseTo(2.5);
    expect(p.look.z).toBeCloseTo(12.5);
  });
});
