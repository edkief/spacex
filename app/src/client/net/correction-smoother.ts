/**
 * TASK-79 — the VISUAL correction smoother (pure, DOM-free, no three.js).
 *
 * The physics reconcile stays authoritative (ClientShipPredictor, shared
 * integrator) — but it can jump the predicted pose by a few u on every 10 Hz
 * snapshot (rewinds) and the chase camera is rigidly attached to the RENDERED
 * ship (TASK-77/78), so any one-frame jump of the pose is a one-frame jump of
 * the whole view: the world pops 10×/s at cruise speed.
 *
 * This class sits BETWEEN the predictor and the renderer. On every reconcile
 * the difference between what was being rendered and the new predicted state
 * becomes an offset (position delta + world-space rotation delta) that decays
 * to zero over ~CORRECTION_TAU_S, so the rendered pose lingers where it was
 * and glides to the corrected prediction instead of snapping. Consecutive
 * corrections ACCUMULATE onto the stored offset (they add instead of
 * replacing), so a burst of snapshots before the next rendered frame glides
 * once. Big discontinuities (teleport, respawn, warp — more than
 * CORRECTION_SNAP_U) clear the offset: those must snap, not glide 100+ m.
 *
 * It never touches the predictor's internal state; `apply` returns a NEW
 * pose each frame, the prediction itself keeps integrating untouched.
 */

import {
  quatIdentity,
  quatInverse,
  quatMultiply,
  quatNormalize,
  quatSlerp,
  vecAdd,
  vecLength,
  vecScale,
  vecSub,
  type Quat,
  type Vec3,
} from '@shared/physics/vec';

/** Time constant (s) of the exponential offset decay — ~100 ms glide. */
export const CORRECTION_TAU_S = 0.1;
/**
 * Corrections larger than this (u) are discontinuities, not drift (teleport,
 * respawn, warp): the offset is CLEARED so the rendered pose snaps in one
 * frame instead of gliding across the map.
 */
export const CORRECTION_SNAP_U = 50;

/** A pose the smoother works on (the predicted/rendered ship state). */
export interface SmootherPose {
  pos: Vec3;
  quat: Quat;
}

const ZERO_OFFSET: Vec3 = { x: 0, y: 0, z: 0 };

export class CorrectionSmoother {
  /** Position offset rendered = predicted + posOffset (u). */
  private posOffset: Vec3 = { ...ZERO_OFFSET };
  /** World-space rotation offset rendered = rotOffset ∘ predicted (quats). */
  private rotOffset: Quat = quatIdentity();

  /**
   * Record a correction: `renderedBefore` is the pose that was being rendered
   * when the reconcile landed, `predictedAfter` the predictor's new state.
   * The delta (renderedBefore − predictedAfter) is ADDED to the stored
   * offsets — back-to-back corrections accumulate rather than reset. A
   * position delta beyond CORRECTION_SNAP_U clears the offsets instead
   * (a teleport/respawn/warp must snap, not glide).
   */
  onCorrection(renderedBefore: SmootherPose, predictedAfter: SmootherPose): void {
    const delta = vecSub(renderedBefore.pos, predictedAfter.pos);
    if (vecLength(delta) > CORRECTION_SNAP_U) {
      this.reset();
      return;
    }
    this.posOffset = vecAdd(this.posOffset, delta);
    // World-space rotation delta renderedBefore · predictedAfter⁻¹, composed
    // ONTO the stored offset (new corrections pre-rotate the old ones, so a
    // burst of corrections glides once at the summed angle).
    const rotDelta = quatMultiply(renderedBefore.quat, quatInverse(predictedAfter.quat));
    this.rotOffset = quatNormalize(quatMultiply(rotDelta, this.rotOffset));
  }

  /**
   * Render pose for this frame: the fresh prediction with the stored
   * offsets applied, both decayed by exp(−dt / CORRECTION_TAU_S) first
   * (rotation: slerped toward identity, so the angle decays exponentially).
   * Returns a new pose; the predictor's state is not modified.
   */
  apply(predicted: SmootherPose, dtSec: number): SmootherPose {
    const f = Math.exp(-Math.max(0, dtSec) / CORRECTION_TAU_S);
    this.posOffset = vecScale(this.posOffset, f);
    // Slerp(identity → offset, f): the offset angle scales by f, i.e. it
    // decays exactly like the position offset.
    this.rotOffset = quatSlerp(quatIdentity(), this.rotOffset, f);
    return {
      pos: vecAdd(predicted.pos, this.posOffset),
      quat: quatNormalize(quatMultiply(this.rotOffset, predicted.quat)),
    };
  }

  /** Clear both offsets (predictor dropped/re-seeded, disembark, warp). */
  reset(): void {
    this.posOffset = { ...ZERO_OFFSET };
    this.rotOffset = quatIdentity();
  }
}
