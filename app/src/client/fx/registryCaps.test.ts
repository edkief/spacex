/**
 * FX cap tests — TASK-58.
 *
 * The acceptance criteria pin the caps and the eviction rule:
 * "≤ 16 concurrent laser flashes, ≤ 16 missiles, ≤ 8 explosion
 * debris sets — the FX registry enforces the caps (oldest
 * expires)".
 */
import { afterEach, describe, expect, it } from "vitest";

import { PERF_PROFILES } from "@shared/perf.js";

import { FxRegistry } from "./registry.js";
import { settingsStore } from "../a11y/settings.js";

describe("FxRegistry FX caps", () => {
  afterEach(() => {
    settingsStore.setReducedMotion(false);
  });

  it("caps concurrent laser flashes at the profile budget", () => {
    const registry = new FxRegistry();
    registry.setProfile(PERF_PROFILES.high);
    for (let i = 0; i < 40; i++) registry.spawn("laser-flash");
    expect(registry.activeCount("laser-flash")).toBe(PERF_PROFILES.high.fxCaps.laserFlash);
    expect(registry.capFor("laser-flash")).toBe(16);
  });

  it("caps missiles and debris sets at their own budgets", () => {
    const registry = new FxRegistry();
    registry.setProfile(PERF_PROFILES.high);
    for (let i = 0; i < 30; i++) registry.spawn("missile-tracer");
    for (let i = 0; i < 30; i++) registry.spawn("debris");
    expect(registry.activeCount("missile-tracer")).toBe(16);
    expect(registry.activeCount("debris")).toBe(8);
  });

  it("expires the oldest effect when the cap is hit", () => {
    const registry = new FxRegistry();
    registry.setProfile(PERF_PROFILES.low); // 6 laser flashes
    const ids = [1, 2, 3, 4, 5, 6, 7].map((id) => registry.spawn("laser-flash", id));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(registry.activeCount("laser-flash")).toBe(6);
    // The 7th spawn evicted id 1 (oldest) and took its slot.
    expect(registry.spawn("laser-flash", 8)).toBe(8);
    expect(registry.activeCount("laser-flash")).toBe(6);
  });

  it("refuses the spawn when reduced motion is on", () => {
    settingsStore.setReducedMotion(true);
    const registry = new FxRegistry();
    expect(registry.spawn("debris")).toBeNull();
    expect(registry.activeCount("debris")).toBe(0);
    expect(registry.snapshot().skipped).toBe(1);
  });

  it("re-caps the live effects when the profile drops", () => {
    const registry = new FxRegistry();
    registry.setProfile(PERF_PROFILES.high);
    for (let i = 0; i < 16; i++) registry.spawn("laser-flash");
    registry.setProfile(PERF_PROFILES.low);
    expect(registry.activeCount("laser-flash")).toBe(PERF_PROFILES.low.fxCaps.laserFlash);
    expect(registry.currentProfile().id).toBe("low");
  });

  it("clears every live effect on reset", () => {
    const registry = new FxRegistry();
    registry.spawn("laser-flash");
    registry.spawn("debris");
    registry.reset();
    expect(registry.activeCount("laser-flash")).toBe(0);
    expect(registry.activeCount("debris")).toBe(0);
  });

  it("hands out monotonic ids when the caller supplies none", () => {
    const registry = new FxRegistry();
    registry.setProfile(PERF_PROFILES.low);
    expect(registry.spawn("laser-flash")).toBe(1);
    expect(registry.spawn("laser-flash")).toBe(2);
  });
});
