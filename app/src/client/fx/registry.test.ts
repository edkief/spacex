/**
 * FX registry test — TASK-54 (reduced motion gate).
 *
 * The registry is the test seam the acceptance criteria mention:
 * "FX count = 0 when on, verified via the FX registry counter".
 */
import { afterEach, describe, expect, it } from "vitest";

import { FxRegistry } from "./registry.js";
import { settingsStore } from "../a11y/settings.js";

describe("FxRegistry", () => {
  afterEach(() => {
    settingsStore.setReducedMotion(false);
  });

  it("plays the effect and counts it when reduced motion is off", () => {
    const registry = new FxRegistry();
    expect(registry.allow("laser-flash")).toBe(true);
    const counters = registry.snapshot();
    expect(counters.played).toBe(1);
    expect(counters.skipped).toBe(0);
  });

  it("skips the effect and counts the skip when reduced motion is on", () => {
    settingsStore.setReducedMotion(true);
    const registry = new FxRegistry();
    expect(registry.allow("explosion")).toBe(false);
    const counters = registry.snapshot();
    expect(counters.played).toBe(0);
    expect(counters.skipped).toBe(1);
    expect(counters.skippedByKind.explosion).toBe(1);
  });

  it("counts every kind separately", () => {
    settingsStore.setReducedMotion(true);
    const registry = new FxRegistry();
    registry.allow("debris");
    registry.allow("debris");
    registry.allow("screen-shake");
    const counters = registry.snapshot();
    expect(counters.skipped).toBe(3);
    expect(counters.skippedByKind.debris).toBe(2);
    expect(counters.skippedByKind["screen-shake"]).toBe(1);
  });

  it("returns a copy so callers cannot mutate the counters", () => {
    const registry = new FxRegistry();
    registry.allow("smoke-trail");
    const snapshot = registry.snapshot();
    snapshot.played = 99;
    expect(registry.snapshot().played).toBe(1);
  });

  it("resets the counters", () => {
    const registry = new FxRegistry();
    registry.allow("laser-flash");
    registry.reset();
    expect(registry.snapshot().played).toBe(0);
  });

  it("takes effect immediately when the flag flips", () => {
    const registry = new FxRegistry();
    expect(registry.allow("laser-flash")).toBe(true);
    settingsStore.setReducedMotion(true);
    expect(registry.allow("laser-flash")).toBe(false);
  });
});
