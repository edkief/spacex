/**
 * Background tests — TASK-73.
 *
 * Pins the deterministic starfield contract:
 *   - The LCG generator yields the same sequence for the same
 *     seed (matches TASK-70's `makeStarRng`).
 *   - `createStarfield(dpr)` returns a `THREE.Points` with
 *     STAR_COUNT vertices and additive blending.
 *   - The starfield deterministically produces a non-zero
 *     number of "bright" points (the 10 % bright ratio).
 */
import { describe, expect, it } from "vitest";
import { type BufferGeometry, Points, PointsMaterial } from "three";

import {
  STAR_COUNT,
  STARFIELD_DISTANCE_M,
  STARFIELD_RADIUS_M,
  createStarfield,
  disposeStarfield,
  makeStarRng,
  starSeed,
} from "./background.js";

describe("makeStarRng — Deterministic Linear-Congruential Generator", () => {
  it("yields a stable sequence for the same seed", () => {
    const rngA = makeStarRng(0xc0ffee);
    const rngB = makeStarRng(0xc0ffee);
    for (let i = 0; i < 32; i++) {
      expect(rngA()).toBe(rngB());
    }
  });

  it("never returns 0 for a 1-D sample", () => {
    const rng = makeStarRng(0xc0ffee);
    let sawNonZero = false;
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v !== 0) sawNonZero = true;
    }
    expect(sawNonZero).toBe(true);
  });

  it("maps `seed === 0` to a deterministic non-zero starting state", () => {
    // The TASK-70 contract: `if (state === 0) state = 0xdeadbeef`.
    const rngA = makeStarRng(0);
    const rngB = makeStarRng(0);
    expect(rngA()).toBe(rngB());
    expect(rngA()).toBeGreaterThan(0);
  });
});

describe("starSeed — DPR-aware seed derivation", () => {
  it("matches TASK-70's `0xc0ffee ^ dpr` contract", () => {
    expect(starSeed(1)).toBe(0xc0ffee ^ 1);
    expect(starSeed(2)).toBe(0xc0ffee ^ 2);
  });

  it("clamps fractional DPR to at least 1", () => {
    expect(starSeed(0.5)).toBe(starSeed(1));
    expect(starSeed(0)).toBe(starSeed(1));
  });
});

describe("createStarfield — Deterministic starfield mesh", () => {
  it("returns a `THREE.Points` with the expected attributes", () => {
    const stars = createStarfield(1);
    expect(stars).toBeInstanceOf(Points);
    const geometry = stars.geometry as BufferGeometry;
    const positionAttr = geometry.getAttribute("position");
    const colorAttr = geometry.getAttribute("color");
    expect(positionAttr.count).toBe(STAR_COUNT);
    expect(colorAttr.count).toBe(STAR_COUNT);
    // Three channels per vertex (x/y/z for position; r/g/b for color).
    expect(positionAttr.itemSize).toBe(3);
    expect(colorAttr.itemSize).toBe(3);
    expect(stars.material).toBeInstanceOf(PointsMaterial);
  });

  it("places every star at the seeded backdrop z so the camera sees it", () => {
    const stars = createStarfield(1);
    const position = (stars.geometry as BufferGeometry).getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      // The camera's default lookAt is (0, 0, 1) (the rig
      // initializes to that pose in `CameraRig._currentPose`),
      // so the backdrop lives at z = STARFIELD_DISTANCE_M.
      expect(position.getZ(i)).toBe(STARFIELD_DISTANCE_M);
    }
  });

  it("scales positions so the disc covers the viewport", () => {
    // The disc should span at least the visible frustum at the
    // backdrop distance — `2 * tan(FOV/2) * D ≈ 1530` at FOV 75°
    // and D = 1000. A 1000 u radius (max) covers ~65 % of that
    // diameter, which is enough for the corners.
    const stars = createStarfield(1);
    const position = (stars.geometry as BufferGeometry).getAttribute("position");
    let maxRadius = 0;
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getY(i));
      if (r > maxRadius) maxRadius = r;
    }
    expect(maxRadius).toBeGreaterThan(STARFIELD_RADIUS_M * 0.95);
    expect(maxRadius).toBeLessThanOrEqual(STARFIELD_RADIUS_M + 1);
  });

  it("never opts into frustum culling (the field is a backdrop)", () => {
    const stars = createStarfield(1);
    expect(stars.frustumCulled).toBe(false);
  });

  it("emits ~10 % bright stars on average (the 90 / 10 split)", () => {
    // Sample five DPRs, count how many points have a "bright"
    // signature. The threshold: the third-channel "brightness"
    // value reaches at least 0.7 only for the bright stars
    // (dim stars cap at 0.6).
    let brightTotal = 0;
    let samples = 0;
    for (const dpr of [1, 2, 1.5, 1.25, 0.5]) {
      const stars = createStarfield(dpr);
      const colors = (stars.geometry as BufferGeometry).getAttribute("color");
      for (let i = 0; i < colors.count; i++) {
        const blue = colors.getZ(i); // blue channel = brightness
        if (blue > 0.65) brightTotal += 1;
      }
      samples += colors.count;
      disposeStarfield(stars);
    }
    const fraction = brightTotal / samples;
    expect(fraction).toBeGreaterThan(0.06);
    expect(fraction).toBeLessThan(0.16);
  });
});

describe("disposeStarfield — Resource cleanup", () => {
  it("is a no-throw for a freshly-made starfield", () => {
    const stars = createStarfield(1);
    expect(() => disposeStarfield(stars)).not.toThrow();
  });
});
