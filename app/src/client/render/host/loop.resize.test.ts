/**
 * Resize path tests — TASK-73.
 *
 * Pins the seam `applyResize(host, cameraRig, w, h)` from
 * `loop.ts`. The actual `WebGLRenderer.setSize` + `setAspect`
 * chain is exercised by the e2e harness (the playwright
 * tests change viewport sizes implicitly; the unit test pins
 * the math).
 */
import { describe, expect, it, vi } from "vitest";

import { applyResize } from "./loop.js";

describe("applyResize — host/rig width/height plumbing", () => {
  it("clamps zero/negative dimensions to 1 (defensive against transient layouts)", () => {
    const renderer = { setSize: vi.fn() };
    const cameraRig = { setAspect: vi.fn() };
    applyResize({ renderer } as never, cameraRig as never, 0, 0);
    expect(renderer.setSize).toHaveBeenCalledWith(1, 1, false);
    expect(cameraRig.setAspect).toHaveBeenCalledWith(1);
  });

  it("forwards CSS-pixel dimensions with updateStyle=false", () => {
    const renderer = { setSize: vi.fn() };
    const cameraRig = { setAspect: vi.fn() };
    applyResize({ renderer } as never, cameraRig as never, 1280, 720);
    expect(renderer.setSize).toHaveBeenCalledWith(1280, 720, false);
    expect(cameraRig.setAspect).toHaveBeenCalledWith(1280 / 720);
  });

  it("rounds fractional dimensions so the GL viewport stays integer-valued", () => {
    const renderer = { setSize: vi.fn() };
    const cameraRig = { setAspect: vi.fn() };
    applyResize({ renderer } as never, cameraRig as never, 1280.7, 720.3);
    expect(renderer.setSize).toHaveBeenCalledWith(1280, 720, false);
  });

  it("recovers from negative dimensions (clamps to 1)", () => {
    const renderer = { setSize: vi.fn() };
    const cameraRig = { setAspect: vi.fn() };
    applyResize({ renderer } as never, cameraRig as never, -5, -10);
    expect(renderer.setSize).toHaveBeenCalledWith(1, 1, false);
    // Aspect is 1/1 — the rig will rebuild its projection on
    // the next frame (deliberately a 1:1 not a NaN).
    expect(cameraRig.setAspect).toHaveBeenCalledWith(1);
  });
});
