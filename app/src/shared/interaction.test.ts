import { describe, expect, it } from 'vitest';

import { quatFromAxisAngle } from './physics/vec';
import {
  INTERACT_CONE_DEG,
  INTERACT_RANGE_M,
  inInteractCone,
  inInteractRange,
  interactConeAngle,
  interactForward,
  isInteractableKind,
  nearestInteractable,
  type InteractableTarget,
} from './interaction';

/**
 * TASK-33: the shared interaction math — the cone/range predicates BOTH the
 * per-frame client raycast and the server's range validation run, so they
 * must agree by construction (one definition, tested here).
 */

/** Feet at the origin, facing +Z. */
const O = { x: 0, y: 0, z: 0 };
const F = { x: 0, y: 0, z: 1 };

const target = (id: string, pos: { x: number; y: number; z: number }): InteractableTarget => ({
  id,
  kind: 'deposit',
  pos,
});

describe('interactForward', () => {
  it('identity / undefined quat → +Z (the local forward convention)', () => {
    expect(interactForward(undefined)).toEqual(F);
    expect(interactForward({ x: 0, y: 0, z: 0, w: 1 })).toEqual(F);
  });

  it('yaw 90° rotates forward to +X (character quats are yaw-only)', () => {
    const fwd = interactForward(quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2));
    expect(fwd.x).toBeCloseTo(1, 10);
    expect(fwd.y).toBeCloseTo(0, 10);
    expect(fwd.z).toBeCloseTo(0, 10);
  });

  it('a degenerate zero quat yields the canonical forward, never zero', () => {
    const fwd = interactForward({ x: 0, y: 0, z: 0, w: 0 });
    expect(fwd).toEqual(F);
  });
});

describe('inInteractRange', () => {
  it('is inclusive at exactly 3 m (the AC boundary)', () => {
    expect(inInteractRange(O, { x: 0, y: 0, z: 3 })).toBe(true);
    expect(inInteractRange(O, { x: 0, y: 0, z: 3.0001 })).toBe(false);
  });

  it('is 3-D (altitude counts, not just the ground plane)', () => {
    // Ground-plane distance 2.5 m (in reach) but 3.2 m in 3-D → out.
    expect(inInteractRange(O, { x: 1.5, y: 2, z: 2 })).toBe(false);
  });

  it('uses the pinned INTERACT_RANGE_M constant', () => {
    expect(INTERACT_RANGE_M).toBe(3);
  });
});

describe('interactConeAngle / inInteractCone', () => {
  it('straight ahead = 0°, the target at the origin = 0° (facing "everywhere")', () => {
    expect(interactConeAngle(O, F, { x: 0, y: 0, z: 10 })).toBe(0);
    expect(interactConeAngle(O, F, { x: 0, y: 0, z: 0 })).toBe(0);
  });

  it('30° is inside (inclusive), 30°+ε is outside', () => {
    // A target sitting exactly on the cone boundary, 10 m out, at `deg` to
    // the LEFT of forward (the cone is symmetric).
    const at = (deg: number) => ({
      x: 10 * Math.sin((deg * Math.PI) / 180),
      y: 0,
      z: 10 * Math.cos((deg * Math.PI) / 180),
    });
    expect(interactConeAngle(O, F, at(30))).toBeCloseTo((30 * Math.PI) / 180, 9);
    expect(inInteractCone(O, F, at(30))).toBe(true);
    expect(inInteractCone(O, F, at(30.1))).toBe(false);
  });

  it('side and behind are never in the cone', () => {
    expect(inInteractCone(O, F, { x: 10, y: 0, z: 0 })).toBe(false); // 90°
    expect(inInteractCone(O, F, { x: 0, y: 0, z: -10 })).toBe(false); // 180°
  });

  it('uses the pinned INTERACT_CONE_DEG constant (half-angle)', () => {
    expect(INTERACT_CONE_DEG).toBe(30);
  });
});

describe('nearestInteractable', () => {
  it('returns the NEAREST target in range and cone, regardless of list order', () => {
    const far = target('far', { x: 0, y: 0, z: 2.5 });
    const near = target('near', { x: 0, y: 0, z: 1 });
    expect(nearestInteractable(O, F, [far, near])?.target.id).toBe('near');
    expect(nearestInteractable(O, F, [near, far])?.target.id).toBe('near');
    expect(nearestInteractable(O, F, [far, near])?.distance).toBeCloseTo(1, 10);
  });

  it('excludes out-of-range and out-of-cone targets; empty/none → null', () => {
    expect(
      nearestInteractable(O, F, [
        target('over', { x: 0, y: 0, z: 4 }),
        target('behind', { x: 0, y: 0, z: -2 }),
        target('side', { x: 3, y: 0, z: 0 }),
      ]),
    ).toBeNull();
    expect(nearestInteractable(O, F, [])).toBeNull();
  });

  it('a 3-D position (above the player) is tested in 3-D distance + cone', () => {
    // 1 m ahead, 1 m right, 1 m up: 3-D distance √3 ≈ 1.73 m (in reach) but
    // ≈ 54.7° off the forward axis → the CONE excludes it.
    expect(nearestInteractable(O, F, [target('up', { x: 1, y: 1, z: 1 })])).toBeNull();
    // 2.5 m ahead and 0.5 m up: 3-D distance √6.5 ≈ 2.55 m, angle ≈ 11.3°
    // → inside both.
    const hit = nearestInteractable(O, F, [target('up', { x: 0, y: 0.5, z: 2.5 })]);
    expect(hit?.target.id).toBe('up');
    expect(hit?.distance).toBeCloseTo(Math.sqrt(6.5), 10);
  });

  it('bit-equal distances break the tie on the SMALLER id (order-independent)', () => {
    const a = target('zz', { x: 0, y: 0, z: 2 });
    const b = target('aa', { x: 0, y: 0, z: 2 });
    expect(nearestInteractable(O, F, [a, b])?.target.id).toBe('aa');
    expect(nearestInteractable(O, F, [b, a])?.target.id).toBe('aa');
  });

  it('honors custom range/cone (the caller may tighten, never the constants change)', () => {
    const t = target('t', { x: 0, y: 0, z: 2 });
    expect(nearestInteractable(O, F, [t], 1.5)).toBeNull();
    expect(nearestInteractable(O, F, [t], 5)?.target.id).toBe('t');
    const side = target('s', { x: 2.5, y: 0, z: 1 }); // ≈ 68° off axis
    expect(nearestInteractable(O, F, [side], 3, 80)?.target.id).toBe('s');
    expect(nearestInteractable(O, F, [side], 3, 30)).toBeNull();
  });
});

describe('isInteractableKind', () => {
  it('accepts exactly the v1 registry key space', () => {
    expect(isInteractableKind('deposit')).toBe(true);
    expect(isInteractableKind('ship')).toBe(true);
    expect(isInteractableKind('terminal')).toBe(true);
    expect(isInteractableKind('character')).toBe(false);
    expect(isInteractableKind('wreck')).toBe(false);
    expect(isInteractableKind('')).toBe(false);
  });
});
