/**
 * useHudMode unit tests — TASK-52.
 *
 * The HUD mode selector is the single source of truth for which
 * HUD subtree (ship vs on-foot) is currently rendered. The
 * component-side mode-coherence test enforces that *one* subtree
 * renders at a time; this test is the pure helper variant.
 */
import { describe, expect, it } from "vitest";

import { hudModeForControls } from "./useHudMode.js";

describe("hudModeForControls (TASK-52)", () => {
  it("returns 'ship' when no Controls instance is available", () => {
    expect(hudModeForControls(undefined)).toBe("ship");
    expect(hudModeForControls(null)).toBe("ship");
  });

  it("returns 'character' when the controls report on-foot", () => {
    const controls = { isOnFoot: () => true } as unknown as Parameters<
      typeof hudModeForControls
    >[0];
    expect(hudModeForControls(controls)).toBe("character");
  });

  it("returns 'ship' when the controls report not-on-foot", () => {
    const controls = { isOnFoot: () => false } as unknown as Parameters<
      typeof hudModeForControls
    >[0];
    expect(hudModeForControls(controls)).toBe("ship");
  });
});
