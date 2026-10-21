/**
 * Shared settings model tests — TASK-55.
 *
 * Pins the preset → pipeline-params table (the acceptance criterion
 * "each preset's params match the spec table"), the sensitivity
 * clamp / step math, the look-delta scaling, and the sanitiser's
 * tolerance for corrupt payloads.
 */
import { describe, expect, it } from "vitest";

import {
  clampSensitivity,
  DEFAULT_SETTINGS,
  KEYBINDS,
  LOOK_RAD_PER_PIXEL,
  pipelineParamsFor,
  QUALITY_PRESET_IDS,
  QUALITY_PRESETS,
  sanitizeSettings,
  scaleLookDelta,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SettingsSchema,
} from "./settings.js";

describe("quality preset table", () => {
  it("maps high to the full-detail budgets", () => {
    expect(QUALITY_PRESETS.high).toEqual({
      chunkDetail: { near: 64, mid: 32, far: 8 },
      drawDistanceM: 8_000,
      starCount: 3_000,
      fxQuality: 1.0,
      atmosphere: "dome",
      missileTrail: "ribbon",
      shadowless: true,
    });
  });

  it("maps medium to the half-detail budgets", () => {
    expect(QUALITY_PRESETS.medium).toEqual({
      chunkDetail: { near: 32, mid: 16, far: 8 },
      drawDistanceM: 6_000,
      starCount: 2_000,
      fxQuality: 0.6,
      atmosphere: "dome",
      missileTrail: "ribbon",
      shadowless: true,
    });
  });

  it("maps low to the quarter-detail budgets", () => {
    expect(QUALITY_PRESETS.low).toEqual({
      chunkDetail: { near: 16, mid: 8, far: 4 },
      drawDistanceM: 4_000,
      starCount: 1_000,
      fxQuality: 0.3,
      atmosphere: "dome",
      missileTrail: "ribbon",
      shadowless: true,
    });
  });

  it("is monotonically cheaper as the preset drops", () => {
    const [high, medium, low] = QUALITY_PRESET_IDS.map((id) => pipelineParamsFor(id));
    expect(medium.drawDistanceM).toBeLessThan(high.drawDistanceM);
    expect(low.drawDistanceM).toBeLessThan(medium.drawDistanceM);
    expect(medium.chunkDetail.near).toBeLessThan(high.chunkDetail.near);
    expect(low.chunkDetail.near).toBeLessThan(medium.chunkDetail.near);
    expect(low.fxQuality).toBeLessThan(medium.fxQuality);
    expect(medium.fxQuality).toBeLessThan(high.fxQuality);
    expect(low.starCount).toBeLessThan(high.starCount);
  });

  it("is shadowless on every preset (no dynamic shadows in v1)", () => {
    for (const id of QUALITY_PRESET_IDS) {
      expect(pipelineParamsFor(id).shadowless).toBe(true);
    }
  });

  it("falls back to high for an unknown preset id", () => {
    expect(pipelineParamsFor("ultra" as never)).toBe(QUALITY_PRESETS.high);
  });
});

describe("clampSensitivity", () => {
  it("clamps above the max and below the min", () => {
    expect(clampSensitivity(2.9)).toBe(SENSITIVITY_MAX);
    expect(clampSensitivity(0.1)).toBe(SENSITIVITY_MIN);
  });

  it("snaps to the 0.1 step without float dust", () => {
    expect(clampSensitivity(1.24)).toBe(1.2);
    expect(clampSensitivity(1.2000000000000002)).toBe(1.2);
  });

  it("passes an in-range value through", () => {
    expect(clampSensitivity(1)).toBe(1);
    expect(clampSensitivity(0.5)).toBe(0.5);
    expect(clampSensitivity(2)).toBe(2);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampSensitivity(Number.NaN)).toBe(1);
    expect(clampSensitivity("nope")).toBe(1);
    expect(clampSensitivity(undefined)).toBe(1);
  });
});

describe("scaleLookDelta", () => {
  it("scales the raw pixel delta by the sensitivity", () => {
    const base = 10 * LOOK_RAD_PER_PIXEL;
    expect(scaleLookDelta(10, 1)).toBeCloseTo(base, 12);
    expect(scaleLookDelta(10, 2)).toBeCloseTo(base * 2, 12);
    expect(scaleLookDelta(10, 0.5)).toBeCloseTo(base * 0.5, 12);
  });

  it("clamps an out-of-range sensitivity before scaling", () => {
    expect(scaleLookDelta(10, 99)).toBeCloseTo(scaleLookDelta(10, SENSITIVITY_MAX), 12);
  });
});

describe("sanitizeSettings", () => {
  it("keeps a valid record", () => {
    expect(sanitizeSettings({ quality: "low", sensitivity: 1.3, reducedMotion: true })).toEqual({
      quality: "low",
      sensitivity: 1.3,
      reducedMotion: true,
      deviceProfile: "auto",
    });
  });

  it("falls back per field", () => {
    expect(sanitizeSettings({ quality: "ultra", sensitivity: 5, reducedMotion: "yes" })).toEqual({
      quality: DEFAULT_SETTINGS.quality,
      sensitivity: SENSITIVITY_MAX,
      reducedMotion: false,
      deviceProfile: DEFAULT_SETTINGS.deviceProfile,
    });
  });

  it("returns the defaults for junk", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("low")).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("SettingsSchema", () => {
  it("accepts the defaults", () => {
    expect(SettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it("rejects an unknown preset and an out-of-range sensitivity", () => {
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, quality: "ultra" }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, sensitivity: 4 }).success).toBe(false);
  });
});

describe("keybind list", () => {
  it("lists the v1 defaults the spec names", () => {
    const rendered = KEYBINDS.map((row) => row.keys).join(" | ");
    for (const expected of ["W A S D", "E", "T", "1 / 2", "M", "ESC", "F3", "Enter"]) {
      expect(rendered).toContain(expected);
    }
  });
});
