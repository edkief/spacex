/**
 * TASK-27 step 3 (component): the CameraRig state machine — a mode switch
 * triggers EXACTLY one 600 ms handoff animation, the camera is not
 * user-controllable during it (input lock), the reverse handoff uses the
 * same rig in reverse, a second handoff (and only a second handoff)
 * cancels the first, and steady-state following has the ~100 ms lag.
 *
 * A controllable fake clock + a real (unattached) THREE camera — the rig
 * is DOM-free, so all of this runs in plain node.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { quatFromEuler } from '@shared/physics/vec';

import { CameraRig, CAMERA_FOV, SMOOTH_K } from './CameraRig';
import {
  cockpitPose,
  HANDOFF_DURATION_MS,
  onFootPose,
  type CameraMode,
  type Vec3,
} from './pose-math';

const STEP_MS = 10;
const SHIP_POS: Vec3 = { x: 0, y: 10, z: 0 };
const CHAR_POS: Vec3 = { x: 0, y: 0, z: 20 };
const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 };

interface RigHarness {
  rig: CameraRig;
  nowMs: { t: number };
  starts: CameraMode[];
  ends: CameraMode[];
  step: (n?: number) => void;
}

function makeRig(): RigHarness {
  const nowMs = { t: 0 };
  const starts: CameraMode[] = [];
  const ends: CameraMode[] = [];
  const rig = new CameraRig({
    camera: new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 10_000),
    heightAt: () => 0,
    now: () => nowMs.t,
    onHandoffStart: (to) => starts.push(to),
    onHandoffEnd: (to) => ends.push(to),
  });
  rig.setShip(SHIP_POS, IDENTITY_QUAT);
  rig.setCharacterPosition(CHAR_POS);
  return {
    rig,
    nowMs,
    starts,
    ends,
    step: (n = 1) => {
      // Clock advances BEFORE the update, like a real rAF timestamp: the
      // 600 ms handoff therefore completes on the update at exactly 600 ms.
      for (let i = 0; i < n; i++) {
        nowMs.t += STEP_MS;
        rig.update(STEP_MS / 1000);
      }
    },
  };
}

/** Run cockpit frames until the k = 8/s chase has settled (≈ 0.5 % left). */
function settle(h: RigHarness): void {
  h.step(150);
}

describe('CameraRig handoff', () => {
  it('mode switch triggers exactly one 600 ms animation (single start + end)', () => {
    const h = makeRig();
    settle(h);
    expect(h.rig.inputLocked).toBe(false);

    const t0 = h.nowMs.t;
    expect(h.rig.handoff('onfoot')).toBe(true);
    expect(h.rig.inputLocked).toBe(true);

    while (h.nowMs.t - t0 < HANDOFF_DURATION_MS + STEP_MS) h.step();

    expect(h.starts).toEqual(['onfoot']); // exactly one animation
    expect(h.ends).toEqual(['onfoot']);
    expect(h.rig.handoffStarts).toBe(1);
    expect(h.rig.inputLocked).toBe(false);
    expect(h.rig.mode).toBe('onfoot');
    // Further frames add no more animations.
    h.step(30);
    expect(h.starts).toHaveLength(1);
    expect(h.ends).toHaveLength(1);
  });

  it('lasts exactly 600 ms: still locked at 590 ms, unlocked by 600 ms', () => {
    const h = makeRig();
    settle(h);
    const t0 = h.nowMs.t;
    h.rig.handoff('onfoot');
    h.step(59); // t = 590 ms
    expect(h.nowMs.t - t0).toBe(590);
    expect(h.rig.inputLocked).toBe(true);
    expect(h.ends).toHaveLength(0);
    h.step(1); // t = 600 ms
    expect(h.rig.inputLocked).toBe(false);
    expect(h.ends).toHaveLength(1);
    expect(h.nowMs.t - t0).toBe(HANDOFF_DURATION_MS);
  });

  it('input lock: look deltas dropped mid-animation, accepted after', () => {
    const h = makeRig();
    settle(h);
    const t0 = h.nowMs.t;
    h.rig.handoff('onfoot');
    h.step(20); // 200 ms in
    expect(h.rig.applyLookDelta(1.5, 1.5)).toBe(false);
    expect(h.rig.lookAngles.yaw).toBe(0);
    expect(h.rig.lookAngles.pitch).toBe(0);
    while (h.nowMs.t - t0 < HANDOFF_DURATION_MS) h.step();
    expect(h.rig.applyLookDelta(0.2, 0.1)).toBe(true);
    expect(h.rig.lookAngles.yaw).toBeCloseTo(0.2);
    expect(h.rig.lookAngles.pitch).toBeCloseTo(0.1);
  });

  it('look deltas are ignored entirely in cockpit mode', () => {
    const h = makeRig();
    settle(h);
    expect(h.rig.applyLookDelta(0.9, 0.9)).toBe(false);
    expect(h.rig.lookAngles).toEqual({ yaw: 0, pitch: 0 });
  });

  it('walks the precomputed path: at t = 300 ms the camera sits on sample 3 of 5', () => {
    const h = makeRig();
    settle(h);
    h.rig.handoff('onfoot');
    h.step(30); // eased progress 0.5 → u = 2 → exactly path[2]
    const path = h.rig.lastPath!;
    expect(path).toHaveLength(5);
    const p = path[2].position;
    expect(h.rig.camera.position.x).toBeCloseTo(p.x, 6);
    expect(h.rig.camera.position.y).toBeCloseTo(p.y, 6);
    expect(h.rig.camera.position.z).toBeCloseTo(p.z, 6);
  });

  it('lands on the on-foot pose (4 m behind, 1.6 m up) and keeps FOV 75', () => {
    const h = makeRig();
    settle(h);
    const t0 = h.nowMs.t;
    h.rig.handoff('onfoot');
    while (h.nowMs.t - t0 < HANDOFF_DURATION_MS) h.step();
    const dest = onFootPose({ pos: CHAR_POS, yaw: 0, pitch: 0 });
    expect(h.rig.camera.position.x).toBeCloseTo(dest.position.x, 6);
    expect(h.rig.camera.position.y).toBeCloseTo(dest.position.y, 6);
    expect(h.rig.camera.position.z).toBeCloseTo(dest.position.z, 6);
    expect(h.rig.camera.fov).toBe(CAMERA_FOV);
  });

  it('reverse handoff (on-foot → cockpit) uses the same rig in reverse', () => {
    const h = makeRig();
    settle(h);
    const t1 = h.nowMs.t;
    h.rig.handoff('onfoot');
    while (h.nowMs.t - t1 < HANDOFF_DURATION_MS) h.step();
    expect(h.rig.mode).toBe('onfoot');

    const t2 = h.nowMs.t;
    expect(h.rig.handoff('cockpit')).toBe(true);
    while (h.nowMs.t - t2 < HANDOFF_DURATION_MS) h.step();
    expect(h.starts).toEqual(['onfoot', 'cockpit']);
    expect(h.ends).toEqual(['onfoot', 'cockpit']);
    expect(h.rig.mode).toBe('cockpit');
    const dest = cockpitPose({ pos: SHIP_POS, quat: IDENTITY_QUAT });
    expect(h.rig.camera.position.x).toBeCloseTo(dest.position.x, 6);
    expect(h.rig.camera.position.y).toBeCloseTo(dest.position.y, 6);
    expect(h.rig.camera.position.z).toBeCloseTo(dest.position.z, 6);
  });

  it('a second handoff mid-animation cancels the first (not input does)', () => {
    const h = makeRig();
    settle(h);
    h.rig.handoff('onfoot');
    h.step(30); // 300 ms into the first
    const midPose = { ...h.rig.currentPose().position };
    h.rig.handoff('cockpit'); // the ONLY thing that can cancel
    expect(h.rig.handoffStarts).toBe(2);
    // The first handoff never finishes; the second completes 600 ms LATER.
    h.step(30); // 600 ms after the first start — still animating
    expect(h.ends).toHaveLength(0);
    expect(h.rig.inputLocked).toBe(true);
    h.step(30); // 900 ms after the first start — second one lands
    expect(h.ends).toEqual(['cockpit']);
    expect(h.rig.mode).toBe('cockpit');
    // Continuity: the restart picked up from the first animation's pose.
    expect(h.rig.lastPath![0].position.x).toBeCloseTo(midPose.x, 3);
    expect(h.rig.lastPath![0].position.y).toBeCloseTo(midPose.y, 3);
    expect(h.rig.lastPath![0].position.z).toBeCloseTo(midPose.z, 3);
  });

  it('pitch is clamped to ±80° by the rig itself', () => {
    const h = makeRig();
    settle(h);
    const t0 = h.nowMs.t;
    h.rig.handoff('onfoot');
    while (h.nowMs.t - t0 < HANDOFF_DURATION_MS) h.step();
    h.rig.applyLookDelta(0, 3); // +172° demand
    expect((h.rig.lookAngles.pitch * 180) / Math.PI).toBeCloseTo(80, 6);
    h.rig.applyLookDelta(0, -20); // demand past the floor
    expect((h.rig.lookAngles.pitch * 180) / Math.PI).toBeCloseTo(-80, 6);
  });

  it('handoff to the current mode with no animation is a no-op', () => {
    const h = makeRig();
    settle(h);
    expect(h.rig.handoff('cockpit')).toBe(false);
    expect(h.rig.handoffStarts).toBe(0);
  });
});

describe('CameraRig steady-state following', () => {
  it('first frame snaps; afterwards the cockpit chases with the k = 8/s lag', () => {
    const h = makeRig();
    h.step(); // prime: snap to the ship pose
    const ship0 = { ...SHIP_POS };
    h.rig.setShip({ x: 0, y: 10, z: 10 }, quatFromEuler(0, 0, 0)); // +10 m forward
    h.step();
    const f = 1 - Math.exp(-(SMOOTH_K * STEP_MS) / 1000);
    const expectedZ = ship0.z + 1.2 + (10 + 1.2 - (ship0.z + 1.2)) * f;
    expect(h.rig.camera.position.z).toBeCloseTo(expectedZ, 6);
    // Strictly between the old and new pose — the smoothing lag is real.
    expect(h.rig.camera.position.z).toBeGreaterThan(ship0.z + 1.2);
    expect(h.rig.camera.position.z).toBeLessThan(10 + 1.2);
    // Converges: after 3 s the chase is within 1e-4 u.
    h.step(300);
    const dest = cockpitPose({ pos: { x: 0, y: 10, z: 10 }, quat: IDENTITY_QUAT });
    expect(h.rig.camera.position.z).toBeCloseTo(dest.position.z, 3);
  });

  it('turns with the ship (90° yaw → camera orbits with the lag)', () => {
    const h = makeRig();
    settle(h);
    h.rig.setShip(SHIP_POS, quatFromEuler(Math.PI / 2, 0, 0));
    h.step();
    // After one frame the camera has started swinging toward +X (was +Z).
    const p0 = h.rig.camera.position;
    expect(p0.x).toBeGreaterThan(0);
    settle(h);
    const dest = cockpitPose({ pos: SHIP_POS, quat: quatFromEuler(Math.PI / 2, 0, 0) });
    expect(h.rig.camera.position.x).toBeCloseTo(dest.position.x, 3);
    expect(h.rig.camera.position.z).toBeCloseTo(dest.position.z, 3);
  });
});
