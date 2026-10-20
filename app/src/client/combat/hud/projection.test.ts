/**
 * Target-box projection math — TASK-50 acceptance.
 *
 * Covers: world → screen for a target dead ahead / off-axis, the
 * behind-camera hide rule, the > 1500 m hide rule, the off-screen
 * hide rule, and the bar-ratio clamp.
 */
import { describe, expect, it } from "vitest";

import {
  TARGET_BOX_MAX_RANGE_M,
  barRatio,
  projectTargetToScreen,
  type TargetProjectionInput,
} from "./projection.js";

const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;

/** Camera at the origin looking down +Z. */
function base(over: Partial<TargetProjectionInput> = {}): TargetProjectionInput {
  return {
    camPos: { x: 0, y: 0, z: 0 },
    camForward: { x: 0, y: 0, z: 1 },
    targetPos: { x: 0, y: 0, z: 100 },
    viewportW: VIEWPORT_W,
    viewportH: VIEWPORT_H,
    ...over,
  };
}

describe("projectTargetToScreen (TASK-50)", () => {
  it("projects a target dead ahead to the viewport centre", () => {
    const p = projectTargetToScreen(base());
    expect(p.visible).toBe(true);
    expect(p.hidden).toBeNull();
    expect(p.x).toBeCloseTo(VIEWPORT_W / 2, 3);
    expect(p.y).toBeCloseTo(VIEWPORT_H / 2, 3);
    expect(p.distanceM).toBeCloseTo(100, 3);
  });

  it("puts a target to the right of the nose right of centre", () => {
    const p = projectTargetToScreen(base({ targetPos: { x: 40, y: 0, z: 100 } }));
    expect(p.visible).toBe(true);
    expect(p.x).toBeGreaterThan(VIEWPORT_W / 2);
    expect(p.y).toBeCloseTo(VIEWPORT_H / 2, 3);
  });

  it("puts a target above the nose above centre", () => {
    const p = projectTargetToScreen(base({ targetPos: { x: 0, y: 30, z: 100 } }));
    expect(p.visible).toBe(true);
    expect(p.y).toBeLessThan(VIEWPORT_H / 2);
  });

  it("halves the NDC offset as the target doubles its range", () => {
    const near = projectTargetToScreen(base({ targetPos: { x: 0, y: 20, z: 100 } }));
    const far = projectTargetToScreen(base({ targetPos: { x: 0, y: 20, z: 200 } }));
    const nearOffset = VIEWPORT_H / 2 - near.y;
    const farOffset = VIEWPORT_H / 2 - far.y;
    expect(nearOffset / farOffset).toBeCloseTo(2, 1);
  });

  it("hides a target behind the camera (dot < 0)", () => {
    const p = projectTargetToScreen(base({ targetPos: { x: 0, y: 0, z: -50 } }));
    expect(p.visible).toBe(false);
    expect(p.hidden).toBe("behind-camera");
  });

  it("hides a target at exactly 90° off the nose", () => {
    const p = projectTargetToScreen(base({ targetPos: { x: 100, y: 0, z: 0 } }));
    expect(p.visible).toBe(false);
    expect(p.hidden).toBe("behind-camera");
  });

  it("hides a target beyond 1500 m and shows one at the edge", () => {
    const far = projectTargetToScreen(base({ targetPos: { x: 0, y: 0, z: 1501 } }));
    expect(far.visible).toBe(false);
    expect(far.hidden).toBe("too-far");
    expect(far.distanceM).toBeGreaterThan(TARGET_BOX_MAX_RANGE_M);
    const edge = projectTargetToScreen(base({ targetPos: { x: 0, y: 0, z: 1500 } }));
    expect(edge.visible).toBe(true);
  });

  it("hides a target projected off screen", () => {
    const p = projectTargetToScreen(base({ targetPos: { x: 0, y: 900, z: 100 } }));
    expect(p.visible).toBe(false);
    expect(p.hidden).toBe("off-screen");
  });

  it("tolerates a non-unit forward vector", () => {
    const p = projectTargetToScreen(
      base({ camForward: { x: 0, y: 0, z: 5 }, targetPos: { x: 0, y: 0, z: 100 } }),
    );
    expect(p.x).toBeCloseTo(VIEWPORT_W / 2, 3);
  });

  it("treats non-finite input as no-lock rather than NaN styles", () => {
    const p = projectTargetToScreen(base({ targetPos: { x: Number.NaN, y: 0, z: 1 } }));
    expect(p.visible).toBe(false);
    expect(p.hidden).toBe("no-lock");
    const zeroViewport = projectTargetToScreen(base({ viewportW: 0, viewportH: 0 }));
    expect(zeroViewport.visible).toBe(false);
    expect(zeroViewport.hidden).toBe("no-lock");
  });
});

describe("barRatio (TASK-50)", () => {
  it("clamps to [0, 1] and survives a bad max", () => {
    expect(barRatio(50, 100)).toBe(0.5);
    expect(barRatio(-5, 100)).toBe(0);
    expect(barRatio(150, 100)).toBe(1);
    expect(barRatio(10, 0)).toBe(0);
    expect(barRatio(Number.NaN, 100)).toBe(0);
  });
});
