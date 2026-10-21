/**
 * Device-profile selection tests — TASK-59.
 *
 * The heuristic is a pure function over a signals object, so these
 * drive it with fake navigator values (no browser): a mid-range
 * phone, a flagship phone, a touch laptop and a desktop.
 */
import { describe, expect, it } from "vitest";

import {
  DETECTED_FALLBACK_PROFILE,
  detectProfile,
  MOBILE_MAX_DEVICE_MEMORY_GB,
  MOBILE_MAX_HARDWARE_CONCURRENCY,
  profileForSettings,
  PROFILE_APPLIED_NOTICE,
  readDeviceSignals,
  resolveProfileId,
  type DeviceSignals,
} from "./deviceProfile.js";
import { PERF_PROFILES } from "./perf.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";

/** A mid-range phone: touch, 4 GB, 4 cores. */
const MID_RANGE_PHONE: DeviceSignals = {
  maxTouchPoints: 5,
  deviceMemory: 4,
  hardwareConcurrency: 4,
};
/** A flagship phone: touch, 12 GB, 8 cores. */
const FLAGSHIP_PHONE: DeviceSignals = {
  maxTouchPoints: 5,
  deviceMemory: 12,
  hardwareConcurrency: 8,
};
/** A desktop. */
const DESKTOP: DeviceSignals = { maxTouchPoints: 0, deviceMemory: 32, hardwareConcurrency: 16 };

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe("detectProfile", () => {
  it("calls a mid-range touch device mobile", () => {
    expect(detectProfile(MID_RANGE_PHONE)).toBe("mobile");
  });

  it("keeps a flagship phone on desktop", () => {
    expect(detectProfile(FLAGSHIP_PHONE)).toBe(DETECTED_FALLBACK_PROFILE);
  });

  it("keeps a desktop on desktop even with weak specs", () => {
    expect(detectProfile({ maxTouchPoints: 0, deviceMemory: 2, hardwareConcurrency: 2 })).toBe(
      "desktop",
    );
  });

  it("treats either weak signal on its own as mid-range", () => {
    expect(
      detectProfile({
        maxTouchPoints: 1,
        deviceMemory: MOBILE_MAX_DEVICE_MEMORY_GB,
        hardwareConcurrency: 16,
      }),
    ).toBe("mobile");
    expect(
      detectProfile({
        maxTouchPoints: 1,
        deviceMemory: 64,
        hardwareConcurrency: MOBILE_MAX_HARDWARE_CONCURRENCY,
      }),
    ).toBe("mobile");
  });

  it("treats missing navigator fields as desktop (conservative)", () => {
    expect(detectProfile({ maxTouchPoints: 0 })).toBe("desktop");
    expect(detectProfile({ maxTouchPoints: 3 })).toBe("desktop");
  });
});

describe("readDeviceSignals", () => {
  it("reads the three navigator fields", () => {
    expect(readDeviceSignals(MID_RANGE_PHONE)).toEqual({
      maxTouchPoints: 5,
      deviceMemory: 4,
      hardwareConcurrency: 4,
    });
  });

  it("defaults a missing navigator to a non-touch device", () => {
    expect(readDeviceSignals({})).toEqual({ maxTouchPoints: 0 });
  });
});

describe("resolveProfileId", () => {
  it("honours the auto override through the heuristic", () => {
    expect(resolveProfileId("auto", MID_RANGE_PHONE)).toBe("mobile");
    expect(resolveProfileId("auto", DESKTOP)).toBe("high");
  });

  it("honours a forced mobile override on a desktop", () => {
    expect(resolveProfileId("mobile", DESKTOP)).toBe("mobile");
  });

  it("honours a forced desktop override on a phone (keeping the preset)", () => {
    expect(resolveProfileId("desktop", MID_RANGE_PHONE, "low")).toBe("low");
    expect(resolveProfileId("desktop", MID_RANGE_PHONE, "high")).toBe("high");
  });
});

describe("profileForSettings", () => {
  it("returns the mobile profile on a detected phone", () => {
    expect(profileForSettings(settings(), MID_RANGE_PHONE)).toBe(PERF_PROFILES.mobile);
  });

  it("returns the preset profile on a desktop", () => {
    expect(profileForSettings(settings({ quality: "medium" }), DESKTOP)).toBe(PERF_PROFILES.medium);
  });

  it("mobile wins over the quality preset", () => {
    expect(
      profileForSettings(settings({ quality: "high", deviceProfile: "mobile" }), DESKTOP),
    ).toBe(PERF_PROFILES.mobile);
  });

  it("ships the notice text the toast uses", () => {
    expect(PROFILE_APPLIED_NOTICE).toBe("Profile applied — re-entering system");
  });
});
