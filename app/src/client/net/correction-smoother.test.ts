/**
 * CorrectionSmoother tests (TASK-79, step 2).
 *
 * The visual correction smoother sits between ClientShipPredictor (the
 * authority, unchanged) and the renderer: a reconcile correction becomes an
 * offset that decays over CORRECTION_TAU_S, back-to-back corrections
 * accumulate, and > CORRECTION_SNAP_U discontinuities snap instead.
 */

import { describe, expect, it } from 'vitest';

import { quatAngleBetween, quatFromAxisAngle, quatIdentity, type Quat } from '@shared/physics/vec';

import {
  CORRECTION_SNAP_U,
  CORRECTION_TAU_S,
  CorrectionSmoother,
  type SmootherPose,
} from './correction-smoother';

/** A pose at the given z (x/y 0) with the given yaw quat. */
function poseAt(z: number, quat: Quat = quatIdentity()): SmootherPose {
  return { pos: { x: 0, y: 0, z }, quat };
}

/** Advance the smoother by `seconds` at 60 fps and return the last pose. */
function decay(s: CorrectionSmoother, predicted: SmootherPose, seconds: number): SmootherPose {
  const dt = 1 / 60;
  let out = predicted;
  for (let t = 0; t < seconds; t += dt) out = s.apply(predicted, dt);
  return out;
}

/** Distance between two poses' positions (u). */
function d(a: SmootherPose, b: SmootherPose): number {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
}

describe('CorrectionSmoother (TASK-79)', () => {
  it('exports the documented constants', () => {
    expect(CORRECTION_TAU_S).toBeCloseTo(0.1, 6);
    expect(CORRECTION_SNAP_U).toBe(50);
  });

  it('a 10 u correction is fully visible on the first frame and < 0.1 u after 0.5 s', () => {
    const s = new CorrectionSmoother();
    const rendered = poseAt(100); // what was being rendered
    const predicted = poseAt(90); // the reconcile moved the prediction back 10 u
    s.onCorrection(rendered, predicted);

    // First frame: the rendered pose is still essentially at `rendered`
    // (the whole correction is visible, not a 50 % blend or a zero glide).
    const first = s.apply(predicted, 1 / 60);
    expect(d(first, rendered)).toBeLessThan(2); // ~1.5 u of 10 u decayed at 60 fps
    expect(d(first, predicted)).toBeGreaterThan(8); // far from the raw prediction

    // After 0.5 s (= 5 time constants) the correction is gone: < 0.1 u left.
    const settled = decay(s, predicted, 0.5);
    expect(d(settled, predicted)).toBeLessThan(0.1);
  });

  it('consecutive corrections accumulate rather than reset', () => {
    const s = new CorrectionSmoother();
    // Two 3 u corrections in the same direction before any rendered frame.
    s.onCorrection(poseAt(106), poseAt(103));
    s.onCorrection(poseAt(109), poseAt(106));
    const p = poseAt(106);
    const first = s.apply(p, 1 / 60);
    // Offset ≈ 3 + 3 = 6 u (decayed slightly in one 60 fps frame).
    expect(d(first, poseAt(112))).toBeLessThan(1.5); // ≈ 6 u above the prediction
    expect(d(first, p)).toBeGreaterThan(4.5);
  });

  it('a correction beyond CORRECTION_SNAP_U snaps (clears the offset)', () => {
    const s = new CorrectionSmoother();
    // Pre-load a 10 u offset, then a 200 u teleport correction.
    s.onCorrection(poseAt(110), poseAt(100));
    s.onCorrection(poseAt(400), poseAt(200)); // 200 u > 50 u → snap
    const out = s.apply(poseAt(200), 1 / 60);
    expect(d(out, poseAt(200))).toBeLessThan(1e-9); // rendered = predicted, no glide
  });

  it('a zero correction is the identity', () => {
    const s = new CorrectionSmoother();
    const p = poseAt(100);
    s.onCorrection(p, p);
    const out = s.apply(p, 1 / 60);
    expect(out.pos).toEqual({ x: 0, y: 0, z: 100 });
    expect(out.quat).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('a rotation offset converges to the prediction orientation', () => {
    const s = new CorrectionSmoother();
    const yaw90 = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const rendered = poseAt(100, yaw90);
    const predicted = poseAt(100, quatIdentity());
    s.onCorrection(rendered, predicted);

    // First frame: still rotated ~90° from the prediction (fully visible —
    // one 60 fps frame decays by exp(−(1/60)/0.1) ≈ 0.85, leaving ~76°).
    const first = s.apply(predicted, 1 / 60);
    expect(quatAngleBetween(first.quat, predicted.quat)).toBeGreaterThan(Math.PI / 2 - 0.25);
    // And ≈ where it was rendered (within one frame of decay: 90° − 76° ≈ 14°).
    expect(quatAngleBetween(first.quat, rendered.quat)).toBeLessThan(0.25);

    // After 0.5 s (= 5 time constants) the offset has slerped back to identity.
    const settled = decay(s, predicted, 0.5);
    expect(quatAngleBetween(settled.quat, predicted.quat)).toBeLessThan(0.02);
  });

  it('never produces NaN for a 180° rotation offset', () => {
    const s = new CorrectionSmoother();
    const flip = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI);
    const rendered = poseAt(100, flip);
    const predicted = poseAt(100, quatIdentity());
    s.onCorrection(rendered, predicted);
    for (let i = 0; i < 120; i++) {
      const out = s.apply(predicted, 1 / 60);
      for (const c of [out.pos.x, out.pos.y, out.pos.z]) expect(Number.isFinite(c)).toBe(true);
      for (const c of [out.quat.x, out.quat.y, out.quat.z, out.quat.w]) {
        expect(Number.isFinite(c)).toBe(true);
      }
    }
  });

  it('composes the rotation offset in world space (rendered quat ≈ renderedBefore on frame one)', () => {
    const s = new CorrectionSmoother();
    const yaw30 = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 6);
    const rendered = poseAt(100, yaw30);
    const predicted = poseAt(100, quatIdentity());
    s.onCorrection(rendered, predicted);
    const out = s.apply(predicted, 0); // dt 0: no decay at all
    expect(quatAngleBetween(out.quat, rendered.quat)).toBeLessThan(1e-9);
  });

  it('reset clears a loaded offset', () => {
    const s = new CorrectionSmoother();
    s.onCorrection(poseAt(110), poseAt(100));
    s.reset();
    const out = s.apply(poseAt(100), 1 / 60);
    expect(d(out, poseAt(100))).toBeLessThan(1e-9);
  });

  it('the applied offset only ever shrinks (monotonic decay)', () => {
    const s = new CorrectionSmoother();
    s.onCorrection(poseAt(108), poseAt(100)); // 8 u
    let prev = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 60; i++) {
      const m = d(s.apply(poseAt(100), 1 / 60), poseAt(100));
      expect(m).toBeLessThanOrEqual(prev + 1e-9);
      prev = m;
    }
  });
});
