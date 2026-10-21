/**
 * World-profile application tests — TASK-59.
 *
 * The profile override is applied on **world load** (the warp
 * transition), not live, so these drive a real `WorldProfileManager`
 * against the real settings store / bridge / FX registry and assert
 * what the warp path does: re-cap the FX, drop the live effects and
 * toast a notice when the profile actually changed.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { PERF_PROFILES } from "@shared/perf.js";
import { PROFILE_APPLIED_NOTICE } from "@shared/deviceProfile.js";
import { DEFAULT_SETTINGS } from "@shared/settings.js";

import { FxRegistry, fxRegistry } from "../fx/registry.js";
import { SettingsStore } from "../a11y/settings.js";
import { SettingsBridge } from "./settingsBridge.js";
import { WorldProfileManager } from "./worldProfile.js";

/** A mid-range phone (touch, 4 GB, 4 cores). */
const PHONE = { maxTouchPoints: 5, deviceMemory: 4, hardwareConcurrency: 4 };
const DESKTOP = { maxTouchPoints: 0, deviceMemory: 32, hardwareConcurrency: 16 };

function harness(signals = DESKTOP) {
  const store = new SettingsStore({ storage: null, initial: { ...DEFAULT_SETTINGS } });
  const bridge = new SettingsBridge({ signals });
  bridge.apply(store.getSnapshot());
  const registry = new FxRegistry();
  registry.setProfile(bridge.profile());
  const manager = new WorldProfileManager({ store, bridge, registry, signals });
  return { store, bridge, registry, manager };
}

describe("WorldProfileManager", () => {
  beforeEach(() => {
    // The process-wide registry is shared with the other suites.
    fxRegistry.reset();
  });

  it("loads the desktop profile on a desktop and stays quiet", () => {
    const { manager } = harness();
    const first = manager.loadWorld();
    expect(first.profileId).toBe("high");
    expect(first.changed).toBe(false);
    expect(first.notice).toBeNull();
    const second = manager.loadWorld();
    expect(second.changed).toBe(false);
    expect(second.notice).toBeNull();
  });

  it("auto-detects a mid-range phone on the first world load", () => {
    const { manager, bridge } = harness(PHONE);
    expect(manager.loadWorld().profileId).toBe("mobile");
    expect(bridge.profile()).toBe(PERF_PROFILES.mobile);
    expect(bridge.current().drawDistanceM).toBe(3_000);
  });

  it("re-applies the override on the next world load and toasts once", () => {
    const { store, manager, bridge } = harness();
    expect(manager.loadWorld().profileId).toBe("high");
    store.setDeviceProfile("mobile");
    const next = manager.loadWorld();
    expect(next.profileId).toBe("mobile");
    expect(next.changed).toBe(true);
    expect(next.notice).toBe(PROFILE_APPLIED_NOTICE);
    expect(bridge.profile()).toBe(PERF_PROFILES.mobile);
    // A second load with the same profile is silent again.
    expect(manager.loadWorld().notice).toBeNull();
  });

  it("re-caps the FX registry and drops live effects on the switch", () => {
    const { store, manager, registry } = harness();
    manager.loadWorld();
    for (let i = 0; i < 16; i += 1) registry.spawn("laser-flash");
    expect(registry.activeCount("laser-flash")).toBe(16);
    store.setDeviceProfile("mobile");
    manager.loadWorld();
    expect(registry.capFor("laser-flash")).toBe(PERF_PROFILES.mobile.fxCaps.laserFlash);
    expect(registry.activeCount("laser-flash")).toBe(0);
  });

  it("preview() reports the next profile without side effects", () => {
    const { store, manager } = harness();
    store.setDeviceProfile("mobile");
    expect(manager.preview()).toBe(PERF_PROFILES.mobile);
  });

  it("keeps gameplay values out of the profile (rendering only)", () => {
    const { manager } = harness(PHONE);
    const profile = manager.loadWorld().profile;
    expect(Object.keys(profile).some((key) => /damage|speed|range|hull/i.test(key))).toBe(false);
  });
});
