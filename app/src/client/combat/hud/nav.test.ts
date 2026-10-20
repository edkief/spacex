/**
 * nav (TASK-51) — bearing math + distance formatter.
 */
import { describe, expect, it } from "vitest";

import { cardinalGlyphFor, formatNavDistance, navReadoutFor } from "./nav.js";

const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 } as const;

describe("formatNavDistance", () => {
  it("formats <1km as integer metres", () => {
    expect(formatNavDistance(342)).toBe("342 m");
    expect(formatNavDistance(0)).toBe("0 m");
    expect(formatNavDistance(999.6)).toBe("1000 m");
  });
  it("formats >=1km as kilometres with one decimal place", () => {
    expect(formatNavDistance(1_000)).toBe("1.0 km");
    expect(formatNavDistance(12_400)).toBe("12.4 km");
    expect(formatNavDistance(1_500)).toBe("1.5 km");
  });
  it("returns ? for non-finite / negative inputs", () => {
    expect(formatNavDistance(-1)).toBe("?");
    expect(formatNavDistance(Number.NaN)).toBe("?");
  });
});

describe("navReadoutFor — atmo / surface mode (no vertical)", () => {
  it("returns bearingDeg = 0 + distance = 0 when at target", () => {
    const r = navReadoutFor({
      shipPos: { x: 0, y: 0, z: 0 },
      shipQuat: IDENTITY_QUAT,
      targetPos: { x: 0, y: 0, z: 0 },
      isSpace: false,
    });
    expect(r.valid).toBe(true);
    expect(r.bearingDeg).toBe(0);
    expect(r.distanceM).toBe(0);
    expect(r.verticalDeg).toBe(0);
  });
  it("puts the target straight ahead as 0°", () => {
    const r = navReadoutFor({
      shipPos: { x: 0, y: 0, z: 0 },
      shipQuat: IDENTITY_QUAT,
      targetPos: { x: 0, y: 0, z: 100 },
      isSpace: false,
    });
    expect(r.valid).toBe(true);
    expect(Math.abs(r.bearingDeg)).toBeLessThan(1);
    expect(r.distanceM).toBeCloseTo(100, 5);
  });
  it("maps a target off the right wing to a positive bearing", () => {
    const r = navReadoutFor({
      shipPos: { x: 0, y: 0, z: 0 },
      shipQuat: IDENTITY_QUAT,
      targetPos: { x: 100, y: 0, z: 0 },
      isSpace: false,
    });
    expect(r.bearingDeg).toBeGreaterThan(80);
    expect(r.bearingDeg).toBeLessThan(100);
  });
  it("maps a target off the left wing to a negative bearing", () => {
    const r = navReadoutFor({
      shipPos: { x: 0, y: 0, z: 0 },
      shipQuat: IDENTITY_QUAT,
      targetPos: { x: -100, y: 0, z: 0 },
      isSpace: false,
    });
    expect(r.bearingDeg).toBeLessThan(-80);
    expect(r.bearingDeg).toBeGreaterThan(-100);
  });
  it("wraps the bearing into [-180, 180]", () => {
    const r = navReadoutFor({
      shipPos: { x: 0, y: 0, z: 0 },
      shipQuat: IDENTITY_QUAT,
      targetPos: { x: 0, y: 0, z: -100 },
      isSpace: false,
    });
    expect(Math.abs(r.bearingDeg)).toBeCloseTo(180, 1);
  });
});

describe("navReadoutFor — space mode (vertical enabled)", () => {
  it("adds verticalDeg for above-the-nose targets", () => {
    const r = navReadoutFor({
      shipPos: { x: 0, y: 0, z: 0 },
      shipQuat: IDENTITY_QUAT,
      targetPos: { x: 0, y: 100, z: 100 },
      isSpace: true,
    });
    expect(r.valid).toBe(true);
    expect(r.verticalDeg).toBeGreaterThan(40);
    expect(r.verticalDeg).toBeLessThanOrEqual(90);
  });
  it("adds negative verticalDeg for below-the-nose targets", () => {
    const r = navReadoutFor({
      shipPos: { x: 0, y: 0, z: 0 },
      shipQuat: IDENTITY_QUAT,
      targetPos: { x: 0, y: -100, z: 100 },
      isSpace: true,
    });
    expect(r.verticalDeg).toBeLessThan(-40);
    expect(r.verticalDeg).toBeGreaterThanOrEqual(-90);
  });
  it("returns 0 verticalDeg in atmosphere / surface modes", () => {
    const r = navReadoutFor({
      shipPos: { x: 0, y: 0, z: 0 },
      shipQuat: IDENTITY_QUAT,
      targetPos: { x: 0, y: 100, z: 100 },
      isSpace: false,
    });
    expect(r.verticalDeg).toBe(0);
  });
});

describe("navReadoutFor — degenerate / invalid inputs", () => {
  it("returns valid:false for non-finite inputs", () => {
    const r = navReadoutFor({
      shipPos: { x: Number.NaN, y: 0, z: 0 },
      shipQuat: IDENTITY_QUAT,
      targetPos: { x: 0, y: 0, z: 100 },
      isSpace: false,
    });
    expect(r.valid).toBe(false);
  });
});

describe("cardinalGlyphFor", () => {
  it("picks ↑ for dead-ahead target", () => {
    expect(cardinalGlyphFor(0)).toBe("↑");
    expect(cardinalGlyphFor(-10)).toBe("↑");
    expect(cardinalGlyphFor(10)).toBe("↑");
  });
  it("picks diagonal glyphs for off-axis targets", () => {
    expect(cardinalGlyphFor(45)).toBe("↗");
    expect(cardinalGlyphFor(-45)).toBe("↖");
  });
  it("picks cardinals for ~90° targets", () => {
    expect(cardinalGlyphFor(90)).toBe("→");
    expect(cardinalGlyphFor(-90)).toBe("←");
  });
  it("picks ↓ for targets behind the ship", () => {
    expect(cardinalGlyphFor(180)).toBe("↓");
    expect(cardinalGlyphFor(-180)).toBe("↓");
    expect(cardinalGlyphFor(135)).toBe("↓");
  });
});
