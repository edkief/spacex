/**
 * shipReadout (TASK-51) — speed / altitude / regime formatters +
 * thrust indicator.
 */
import { describe, expect, it } from "vitest";

import {
  formatSpeed,
  formatAltitude,
  regimeTagFor,
  surfaceAltitudeM,
  thrustIndicatorFor,
} from "./shipReadout.js";

describe("formatSpeed", () => {
  it("formats one decimal place", () => {
    expect(formatSpeed(0)).toBe("0.0");
    expect(formatSpeed(12.4)).toBe("12.4");
    expect(formatSpeed(100)).toBe("100.0");
    expect(formatSpeed(99.99)).toBe("100.0");
  });
  it("clamps negatives to 0.0", () => {
    expect(formatSpeed(-5)).toBe("0.0");
    expect(formatSpeed(-1000)).toBe("0.0");
  });
  it("collapses non-finite values to 0.0", () => {
    expect(formatSpeed(Number.NaN)).toBe("0.0");
    expect(formatSpeed(Number.POSITIVE_INFINITY)).toBe("0.0");
  });
});

describe("formatAltitude", () => {
  it("shows '—' in space", () => {
    expect(formatAltitude("space", 12345)).toBe("—");
    expect(formatAltitude("orbit", 12345)).toBe("—");
  });
  it("shows 'ALT X m' in atmosphere / surface", () => {
    expect(formatAltitude("atmosphere", 1234)).toBe("ALT 1234 m");
    expect(formatAltitude("surface", 0)).toBe("ALT 0 m");
    expect(formatAltitude("surface", 12.7)).toBe("ALT 13 m");
  });
  it("falls back to 'ALT — m' when altitude unknown outside space", () => {
    expect(formatAltitude("atmosphere", null)).toBe("ALT — m");
    expect(formatAltitude("surface", undefined)).toBe("ALT — m");
  });
  it("collapses non-finite values to 'ALT — m'", () => {
    expect(formatAltitude("atmosphere", Number.NaN)).toBe("ALT — m");
  });
});

describe("regimeTagFor", () => {
  it("maps wire regimes to the HUD three-letter tag", () => {
    expect(regimeTagFor("space")).toBe("SPACE");
    expect(regimeTagFor("orbit")).toBe("SPACE");
    expect(regimeTagFor("atmosphere")).toBe("ATMOS");
    expect(regimeTagFor("surface")).toBe("SURFACE");
  });
  it("falls back to SPACE for unknown inputs", () => {
    expect(regimeTagFor(null)).toBe("SPACE");
    expect(regimeTagFor("unknown")).toBe("SPACE");
    expect(regimeTagFor(undefined)).toBe("SPACE");
  });
});

describe("surfaceAltitudeM", () => {
  it("returns pos.y minus planet radius (in metres)", () => {
    expect(surfaceAltitudeM({ x: 0, y: 6_378_000, z: 0 }, 6_371_000)).toBe(7_000);
  });
  it("returns 0 when the ship is below the surface (clamped)", () => {
    expect(surfaceAltitudeM({ x: 0, y: 6_000_000, z: 0 }, 6_371_000)).toBe(0);
  });
  it("returns null on missing inputs", () => {
    expect(surfaceAltitudeM(null, 100)).toBe(null);
    expect(surfaceAltitudeM({ x: 0, y: 1, z: 0 }, null)).toBe(null);
  });
});

describe("thrustIndicatorFor", () => {
  it("renders a centre stub for null / NaN / 0", () => {
    expect(thrustIndicatorFor(null)).toEqual({ offsetPx: 0, lengthPx: 1 });
    expect(thrustIndicatorFor(Number.NaN)).toEqual({ offsetPx: 0, lengthPx: 1 });
    expect(thrustIndicatorFor(0)).toEqual({ offsetPx: 0, lengthPx: 1 });
  });
  it("renders positive thrust above the baseline", () => {
    const r = thrustIndicatorFor(0.5);
    expect(r.offsetPx).toBe(0);
    expect(r.lengthPx).toBe(30);
  });
  it("renders reverse (negative thrust) below the baseline", () => {
    const r = thrustIndicatorFor(-1);
    expect(r.offsetPx).toBeLessThan(0);
    expect(r.lengthPx).toBe(60);
  });
  it("clamps to ±1", () => {
    const hi = thrustIndicatorFor(5);
    expect(hi.lengthPx).toBe(60);
    const lo = thrustIndicatorFor(-5);
    expect(lo.lengthPx).toBe(60);
  });
});
