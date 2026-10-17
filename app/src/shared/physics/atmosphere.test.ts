/**
 * Atmosphere boundary tests. Shared with TASK-28 — both the flight
 * model and the visual entry/exit effect must read from the same
 * function so they cannot desync.
 */

import { describe, expect, it } from "vitest";
import {
  BOUNDARY_RAMP_WIDTH_M,
  DEFAULT_ATMOSPHERE_HEIGHT_M,
  altitudeFromPlanet,
  boundaryFactor,
  dragCoefficient,
  makeFlatPlanet,
  type PlanetAtmosphere,
} from "./atmosphere.js";

const TEST_RADIUS = 5_000_000; // 5000 km in metres

function flatPlanet(overrides: Partial<PlanetAtmosphere> = {}): PlanetAtmosphere {
  return makeFlatPlanet({
    id: "test-planet",
    radius: TEST_RADIUS,
    ...overrides,
  });
}

describe("atmosphere: constants", () => {
  it("boundary ramp is 1 km per spec", () => {
    expect(BOUNDARY_RAMP_WIDTH_M).toBe(1000);
  });

  it("default atmosphere height is 10 km", () => {
    expect(DEFAULT_ATMOSPHERE_HEIGHT_M).toBe(10_000);
  });
});

describe("atmosphere: boundaryFactor", () => {
  it("returns 0 for planets without an atmosphere", () => {
    const p = flatPlanet({ hasAtmosphere: false });
    expect(boundaryFactor(0, p)).toBe(0);
    expect(boundaryFactor(500, p)).toBe(0);
    expect(boundaryFactor(-100, p)).toBe(0);
  });

  it("returns 1 at the surface (altitude <= 0)", () => {
    const p = flatPlanet();
    expect(boundaryFactor(0, p)).toBe(1);
    expect(boundaryFactor(-100, p)).toBe(1);
  });

  it("returns 0 above the boundary band", () => {
    const p = flatPlanet();
    expect(boundaryFactor(BOUNDARY_RAMP_WIDTH_M, p)).toBe(0);
    expect(boundaryFactor(BOUNDARY_RAMP_WIDTH_M + 1, p)).toBe(0);
    expect(boundaryFactor(999_999, p)).toBe(0);
  });

  it("ramps linearly within the boundary band", () => {
    const p = flatPlanet();
    expect(boundaryFactor(BOUNDARY_RAMP_WIDTH_M * 0.5, p)).toBeCloseTo(0.5, 12);
    expect(boundaryFactor(BOUNDARY_RAMP_WIDTH_M * 0.25, p)).toBeCloseTo(0.75, 12);
    expect(boundaryFactor(BOUNDARY_RAMP_WIDTH_M * 0.75, p)).toBeCloseTo(0.25, 12);
  });

  it("is continuous at the boundary edges", () => {
    const p = flatPlanet();
    // Just below the boundary end (BOUNDARY_RAMP_WIDTH_M) and at it.
    const a = boundaryFactor(BOUNDARY_RAMP_WIDTH_M - 1e-9, p);
    const b = boundaryFactor(BOUNDARY_RAMP_WIDTH_M, p);
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
  });
});

describe("atmosphere: dragCoefficient", () => {
  it("returns 0 above the boundary band", () => {
    const p = flatPlanet({ atmosphereDensity: 1 });
    expect(dragCoefficient(BOUNDARY_RAMP_WIDTH_M + 1, p, 100, 1)).toBe(0);
    expect(dragCoefficient(BOUNDARY_RAMP_WIDTH_M * 10, p, 100, 1)).toBe(0);
  });

  it("returns full k at the surface (altitude 0)", () => {
    const p = flatPlanet({ atmosphereDensity: 1 });
    expect(dragCoefficient(0, p, 100, 1)).toBeCloseTo(100, 12);
  });

  it("scales with atmosphereDensity", () => {
    const thin = flatPlanet({ atmosphereDensity: 0.5 });
    const thick = flatPlanet({ atmosphereDensity: 2 });
    expect(dragCoefficient(0, thin, 100, 1)).toBeCloseTo(50, 12);
    expect(dragCoefficient(0, thick, 100, 1)).toBeCloseTo(200, 12);
  });

  it("scales with mass / area per spec", () => {
    const p = flatPlanet({ atmosphereDensity: 1 });
    // mass=20, area=1 → k=20
    expect(dragCoefficient(0, p, 20, 1)).toBeCloseTo(20, 12);
    // mass=120, area=1 → k=120
    expect(dragCoefficient(0, p, 120, 1)).toBeCloseTo(120, 12);
    // mass=120, area=2 → k=60
    expect(dragCoefficient(0, p, 120, 2)).toBeCloseTo(60, 12);
  });

  it("ramps 0 → k over the boundary band", () => {
    const p = flatPlanet({ atmosphereDensity: 1 });
    const kFull = dragCoefficient(0, p, 100, 1);
    expect(dragCoefficient(BOUNDARY_RAMP_WIDTH_M * 0.5, p, 100, 1)).toBeCloseTo(kFull * 0.5, 12);
    expect(dragCoefficient(BOUNDARY_RAMP_WIDTH_M * 0.75, p, 100, 1)).toBeCloseTo(kFull * 0.25, 12);
  });
});

describe("atmosphere: altitudeFromPlanet", () => {
  it("returns 0 at or below the surface", () => {
    const p = flatPlanet();
    expect(altitudeFromPlanet({ x: 0, y: TEST_RADIUS, z: 0 }, p)).toBe(0);
    expect(altitudeFromPlanet({ x: 0, y: TEST_RADIUS - 100, z: 0 }, p)).toBe(0);
  });

  it("returns y - radius above the surface", () => {
    const p = flatPlanet();
    expect(altitudeFromPlanet({ x: 0, y: TEST_RADIUS + 100, z: 0 }, p)).toBe(100);
    expect(altitudeFromPlanet({ x: 0, y: TEST_RADIUS + 5000, z: 0 }, p)).toBe(5000);
  });
});

describe("atmosphere: determinism", () => {
  it("boundaryFactor is a pure function", () => {
    const p = flatPlanet();
    const r1 = boundaryFactor(437.5, p);
    const r2 = boundaryFactor(437.5, p);
    expect(r1).toBe(r2);
  });

  it("boundaryFactor bit-identical across calls", () => {
    const p = flatPlanet();
    for (let i = 0; i < 100; i++) {
      const alt = (i * 13.37) % 1500;
      const r1 = boundaryFactor(alt, p);
      const r2 = boundaryFactor(alt, p);
      expect(r1).toBe(r2);
    }
  });
});
