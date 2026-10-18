/**
 * Atmosphere visuals tests — TASK-28.
 *
 * Covers the math behind the visual entry/exit transition:
 *
 *   - `visualProfileForPlanet` returns deterministic per-class
 *     profiles (acceptance: "two planets in the seeded galaxy
 *     differ" → assert `terran.densityScale` vs `rocky.densityScale`
 *     differ by > 20%).
 *   - `hazeFactor` is continuous across the boundary band (no
 *     pop at any altitude).
 *   - `hazeFactor` clamps at 0 in space and 1 at the surface
 *     (or below) — same `BOUNDARY_RAMP_WIDTH_M` band the drag
 *     ramp uses.
 *   - `reentryTint` is 0 below the descent threshold, ramps
 *     linearly to 1 at the peak, and is multiplied by
 *     `boundaryFactor` so it never fires in pure space.
 *   - `atmosphereVisualState` returns consistent snapshot.
 *   - Per-planet-class density difference satisfies the > 20%
 *     acceptance criterion for the seeded galaxy.
 *
 * @see ./atmosphere-visuals.ts
 */

import { describe, expect, it } from "vitest";

import { BOUNDARY_RAMP_WIDTH_M, makeFlatPlanet } from "./atmosphere.js";
import {
  REENTRY_DESCENT_SPEED_U_S,
  REENTRY_DESATURATION_PEAK_U_S,
  REENTRY_RIM_COLOR,
  atmosphereVisualState,
  hazeFactor,
  reentryTint,
  rgbToCss,
  visualProfileForPlanet,
  type AtmosphereVisualProfile,
} from "./atmosphere-visuals.js";
import { generateSystem } from "../galaxy/system.js";
import { sampleStar } from "../galaxy/system.helpers.js";

const TEST_RADIUS = 5_000_000; // 5000 km in metres
const STUB_PLANET = makeFlatPlanet({
  id: "stub",
  radius: TEST_RADIUS,
  atmosphereDensity: 1,
  hasAtmosphere: true,
});
const NO_ATMO = makeFlatPlanet({
  id: "stub",
  radius: TEST_RADIUS,
  hasAtmosphere: false,
});

// ---------------------------------------------------------------------------
// visualProfileForPlanet
// ---------------------------------------------------------------------------

describe("atmosphere-visuals: visualProfileForPlanet", () => {
  it("returns the no-atmosphere profile when hasAtmosphere is false", () => {
    const profile = visualProfileForPlanet({ class: "terran", hasAtmosphere: false });
    expect(profile.hasAtmosphere).toBe(false);
    expect(profile.densityScale).toBe(0);
    expect(profile.hazeColor.r).toBe(0);
    expect(profile.hazeColor.g).toBe(0);
    expect(profile.hazeColor.b).toBe(0);
  });

  it("returns a deterministic per-class profile", () => {
    const terran = visualProfileForPlanet({ class: "terran", hasAtmosphere: true });
    const rocky = visualProfileForPlanet({ class: "rocky", hasAtmosphere: true });
    // Different classes get different profiles (acceptance: "two
    // planets differ").
    expect(terran.hazeColor.r).not.toBe(rocky.hazeColor.r);
    expect(terran.densityScale).not.toBe(rocky.densityScale);
  });

  it("falls back to terran for unknown planet classes", () => {
    // Defensive: a future planet class added to the seed but not
    // to the palette should not break rendering.
    const profile = visualProfileForPlanet({
      class: "plasma" as unknown as "terran",
      hasAtmosphere: true,
    });
    const terran = visualProfileForPlanet({ class: "terran", hasAtmosphere: true });
    expect(profile.hazeColor).toEqual(terran.hazeColor);
  });
});

describe("atmosphere-visuals: per-planet density difference (acceptance)", () => {
  it("terran vs rocky differ by > 20% on density", () => {
    const terran = visualProfileForPlanet({ class: "terran", hasAtmosphere: true });
    const rocky = visualProfileForPlanet({ class: "rocky", hasAtmosphere: true });
    const denom = Math.max(terran.densityScale, rocky.densityScale);
    const diff = Math.abs(terran.densityScale - rocky.densityScale) / denom;
    expect(diff).toBeGreaterThan(0.2);
  });

  it("two seeded planets differ on density (seeded galaxy assertion)", () => {
    // The acceptance criterion mentions "two planets in the seeded
    // galaxy differ" — we assert the seeded galaxy produces
    // atmosphere-bearing planets whose density scales differ by
    // > 20%.
    const seed = "DRIFT-SEED-0001";
    const system = generateSystem(seed, sampleStar());
    const withAtmosphere = system.planets.filter((p) => p.hasAtmosphere);
    expect(withAtmosphere.length).toBeGreaterThanOrEqual(2);
    const profiles = withAtmosphere.map((p) => visualProfileForPlanet(p));
    // Find two profiles with the largest density-scale gap.
    let maxGap = 0;
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const a = profiles[i]!.densityScale;
        const b = profiles[j]!.densityScale;
        const denom = Math.max(a, b);
        if (denom <= 0) continue;
        const gap = Math.abs(a - b) / denom;
        if (gap > maxGap) maxGap = gap;
      }
    }
    expect(maxGap).toBeGreaterThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// hazeFactor
// ---------------------------------------------------------------------------

describe("atmosphere-visuals: hazeFactor", () => {
  const profile: AtmosphereVisualProfile = visualProfileForPlanet({
    class: "terran",
    hasAtmosphere: true,
  });

  it("is 0 in space (above the boundary band)", () => {
    expect(hazeFactor(BOUNDARY_RAMP_WIDTH_M + 1, profile)).toBe(0);
    expect(hazeFactor(BOUNDARY_RAMP_WIDTH_M * 10, profile)).toBe(0);
    expect(hazeFactor(10_000, profile)).toBe(0);
  });

  it("is 1 at the surface (altitude <= 0) for a density 1.0 planet", () => {
    expect(hazeFactor(0, profile)).toBeCloseTo(1, 12);
    expect(hazeFactor(-100, profile)).toBeCloseTo(1, 12);
  });

  it("ramps linearly within the boundary band (same shape as drag)", () => {
    expect(hazeFactor(BOUNDARY_RAMP_WIDTH_M * 0.5, profile)).toBeCloseTo(0.5, 12);
    expect(hazeFactor(BOUNDARY_RAMP_WIDTH_M * 0.25, profile)).toBeCloseTo(0.75, 12);
    expect(hazeFactor(BOUNDARY_RAMP_WIDTH_M * 0.75, profile)).toBeCloseTo(0.25, 12);
  });

  it("is 0 when the planet has no atmosphere (regardless of altitude)", () => {
    const noAtmoProfile = visualProfileForPlanet({ class: "terran", hasAtmosphere: false });
    expect(hazeFactor(0, noAtmoProfile)).toBe(0);
    expect(hazeFactor(500, noAtmoProfile)).toBe(0);
  });

  it("is continuous at the boundary edges (no pop)", () => {
    // Just below BOUNDARY_RAMP_WIDTH_M and at it: no discontinuity.
    const a = hazeFactor(BOUNDARY_RAMP_WIDTH_M - 1e-9, profile);
    const b = hazeFactor(BOUNDARY_RAMP_WIDTH_M, profile);
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
    // At the surface: still continuous.
    const c = hazeFactor(0, profile);
    const d = hazeFactor(-1e-9, profile);
    expect(Math.abs(c - d)).toBeLessThan(1e-6);
  });

  it("scales with densityScale (acceptance: per-planet density scaling)", () => {
    // Two planets with the same shape but different density
    // scales. At mid-band the haze alpha must differ by the
    // density-scale ratio.
    const dense = visualProfileForPlanet({ class: "gas", hasAtmosphere: true });
    const thin = visualProfileForPlanet({ class: "rocky", hasAtmosphere: true });
    const alt = BOUNDARY_RAMP_WIDTH_M * 0.5;
    const denseHaze = hazeFactor(alt, dense);
    const thinHaze = hazeFactor(alt, thin);
    // gas.densityScale = 1.5; rocky.densityScale = 0.5 → ratio = 3.0.
    expect(denseHaze / thinHaze).toBeCloseTo(dense.densityScale / thin.densityScale, 6);
    // Per-acceptance, the haze factor at mid-boundary must differ
    // by > 20% between two planets in the seeded galaxy.
    expect(Math.abs(denseHaze - thinHaze) / Math.max(denseHaze, thinHaze)).toBeGreaterThan(0.2);
  });

  it("clamps to [0, 1] even when densityScale > 1", () => {
    // A planet with densityScale 1.5 must not blow past 1 at the
    // surface (the shader's alpha uniform clamps).
    const gas = visualProfileForPlanet({ class: "gas", hasAtmosphere: true });
    expect(hazeFactor(0, gas)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// reentryTint
// ---------------------------------------------------------------------------

describe("atmosphere-visuals: reentryTint", () => {
  it("is 0 below the descent threshold", () => {
    expect(reentryTint(0, 1).alpha).toBe(0);
    expect(reentryTint(REENTRY_DESCENT_SPEED_U_S - 1, 1).alpha).toBe(0);
    expect(reentryTint(REENTRY_DESCENT_SPEED_U_S - 1e-9, 1).alpha).toBe(0);
  });

  it("ramps linearly between threshold and peak", () => {
    const mid = (REENTRY_DESCENT_SPEED_U_S + REENTRY_DESATURATION_PEAK_U_S) / 2;
    const t = reentryTint(mid, 1);
    expect(t.alpha).toBeCloseTo(0.5, 6);
  });

  it("is 1 at the peak", () => {
    expect(reentryTint(REENTRY_DESATURATION_PEAK_U_S, 1).alpha).toBeCloseTo(1, 12);
    expect(reentryTint(REENTRY_DESATURATION_PEAK_U_S * 2, 1).alpha).toBeCloseTo(1, 12);
  });

  it("never fires in pure space (boundary multiplied in)", () => {
    // Even at maximum descent speed, if boundary = 0 (above the
    // boundary band) the rim stays invisible.
    expect(reentryTint(1000, 0).alpha).toBe(0);
    expect(reentryTint(1000, 1e-9).alpha).toBeLessThan(1e-6);
  });

  it("scales linearly with boundaryFactor", () => {
    const full = reentryTint(REENTRY_DESATURATION_PEAK_U_S, 1).alpha;
    const half = reentryTint(REENTRY_DESATURATION_PEAK_U_S, 0.5).alpha;
    expect(half).toBeCloseTo(full * 0.5, 12);
  });

  it("ignores negative descent (ascent = no heating)", () => {
    expect(reentryTint(-100, 1).alpha).toBe(0);
    expect(reentryTint(-1000, 1).alpha).toBe(0);
  });

  it("returns the orange colour constant", () => {
    const { color } = reentryTint(0, 1);
    expect(color.r).toBe(REENTRY_RIM_COLOR[0]);
    expect(color.g).toBe(REENTRY_RIM_COLOR[1]);
    expect(color.b).toBe(REENTRY_RIM_COLOR[2]);
  });
});

// ---------------------------------------------------------------------------
// atmosphereVisualState
// ---------------------------------------------------------------------------

describe("atmosphere-visuals: atmosphereVisualState", () => {
  it("returns consistent snapshot for terran at surface", () => {
    const profile = visualProfileForPlanet({ class: "terran", hasAtmosphere: true });
    const state = atmosphereVisualState(0, 100, STUB_PLANET, profile);
    expect(state.haze).toBeCloseTo(1, 12);
    // descentSpeed 100 < threshold 200 → reentry 0
    expect(state.reentryAlpha).toBe(0);
    expect(state.hazeColor).toEqual(profile.hazeColor);
    expect(state.skyColor).toEqual(profile.skyColor);
  });

  it("returns consistent snapshot for descent at high speed", () => {
    const profile = visualProfileForPlanet({ class: "terran", hasAtmosphere: true });
    // Altitude mid-band, full reentry speed.
    const state = atmosphereVisualState(
      BOUNDARY_RAMP_WIDTH_M * 0.5,
      REENTRY_DESATURATION_PEAK_U_S,
      STUB_PLANET,
      profile,
    );
    // haze ≈ 0.5 * densityScale(1.0) = 0.5
    expect(state.haze).toBeCloseTo(0.5, 12);
    // reentry alpha: full threshold reached * boundary 0.5
    expect(state.reentryAlpha).toBeCloseTo(0.5, 6);
  });

  it("is 0 in pure space (above the boundary)", () => {
    const profile = visualProfileForPlanet({ class: "terran", hasAtmosphere: true });
    const state = atmosphereVisualState(BOUNDARY_RAMP_WIDTH_M + 100, 1000, STUB_PLANET, profile);
    expect(state.haze).toBe(0);
    expect(state.reentryAlpha).toBe(0);
  });

  it("no-atmosphere planet yields 0/0 regardless of inputs", () => {
    const profile = visualProfileForPlanet({ class: "terran", hasAtmosphere: false });
    const state = atmosphereVisualState(0, 1000, NO_ATMO, profile);
    expect(state.haze).toBe(0);
    expect(state.reentryAlpha).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rgbToCss
// ---------------------------------------------------------------------------

describe("atmosphere-visuals: rgbToCss", () => {
  it("formats RGB as CSS rgba()", () => {
    expect(rgbToCss({ r: 0, g: 0, b: 0 })).toBe("rgba(0, 0, 0, 1)");
    expect(rgbToCss({ r: 1, g: 1, b: 1 }, 0.5)).toBe("rgba(255, 255, 255, 0.5)");
    expect(rgbToCss({ r: 0.5, g: 0.5, b: 0.5 }, 0.25)).toBe("rgba(128, 128, 128, 0.25)");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("atmosphere-visuals: determinism", () => {
  it("hazeFactor is a pure function (no Math.random)", () => {
    const profile = visualProfileForPlanet({ class: "terran", hasAtmosphere: true });
    for (let i = 0; i < 100; i++) {
      const alt = (i * 13.37) % 1500;
      const a = hazeFactor(alt, profile);
      const b = hazeFactor(alt, profile);
      expect(a).toBe(b);
    }
  });

  it("reentryTint is a pure function", () => {
    for (let i = 0; i < 100; i++) {
      const speed = i * 7.13;
      const a = reentryTint(speed, 0.5);
      const b = reentryTint(speed, 0.5);
      expect(a).toEqual(b);
    }
  });

  it("atmosphereVisualState is a pure function", () => {
    const profile = visualProfileForPlanet({ class: "gas", hasAtmosphere: true });
    const a = atmosphereVisualState(500, 300, STUB_PLANET, profile);
    const b = atmosphereVisualState(500, 300, STUB_PLANET, profile);
    expect(a).toEqual(b);
  });
});
