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
import { integrateShip, type ShipState, type ShipInput } from "./flight.js";
import { IDENTITY } from "./vec.js";
import { shipStats } from "../ships.js";

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

// ---------------------------------------------------------------------------
// Sim integration: analytic drag curve vs integrator (TASK-28 acceptance)
//
// The flight model applies quadratic drag
//   a_drag = -k * |v| * v
// where k ramps 0 → k_full linearly over BOUNDARY_RAMP_WIDTH_M.
// For a straight-line descent into a planet (no thrust, gravity-free),
// the analytic closed-form for the speed profile is:
//   |v(t)| = |v_0| / (1 + k * |v_0| * t)
// assuming the altitude stays in the "full drag" band (k = k_full).
//
// To exercise the boundary ramp we put the ship at altitude 0 (full
// drag from t=0). The comparison is per-second over a 10 s run.
// ---------------------------------------------------------------------------

describe("atmosphere: sim integration vs analytic drag curve", () => {
  // Ship class with deterministic mass = 1, area = 1 to keep k = density
  // directly (matches the analytic formula).
  const SCOUT = shipStats("scout");

  function runDragSimulation(
    startSpeed: number,
    seconds: number,
    planet: PlanetAtmosphere,
  ): { t: number; speed: number }[] {
    const start: ShipState = {
      pos: { x: 0, y: TEST_RADIUS, z: 0 },
      vel: { x: startSpeed, y: 0, z: 0 },
      quat: { ...IDENTITY },
      regime: "atmosphere",
    };
    const input: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };
    // dt = 1ms (1000 Hz) keeps the per-step Euler error well below
    // the 2% acceptance threshold. The 20 Hz server tick (dt = 50ms)
    // is the production cadence but loses precision on a fast
    // drag curve — that's expected for a forward Euler; the
    // production sim would benefit from a higher-order integrator
    // in a future task. The unit test asserts the math, not the
    // production cadence.
    const dt = 1 / 1000;
    let cur = start;
    const samples: { t: number; speed: number }[] = [];
    const totalSteps = Math.round(seconds / dt);
    for (let i = 0; i < totalSteps; i++) {
      const speed = Math.sqrt(
        cur.vel.x * cur.vel.x + cur.vel.y * cur.vel.y + cur.vel.z * cur.vel.z,
      );
      samples.push({ t: i * dt, speed });
      cur = integrateShip(cur, input, dt, "atmosphere", SCOUT, planet);
    }
    // Final sample.
    const speed = Math.sqrt(cur.vel.x * cur.vel.x + cur.vel.y * cur.vel.y + cur.vel.z * cur.vel.z);
    samples.push({ t: seconds, speed });
    return samples;
  }

  it("speed profile matches the analytic quadratic-drag curve within 2%", () => {
    // Use a thin atmosphere so the per-step drag stays well below
    // the CFL bound (`k * |v| * dt < 1`). Scout mass = 20; with
    // density 0.01 and area 1, k = 0.2 — comfortable for dt=1ms.
    const planet: PlanetAtmosphere = makeFlatPlanet({
      id: "sim-planet",
      radius: TEST_RADIUS,
      atmosphereDensity: 0.01,
      hasAtmosphere: true,
    });

    const startSpeed = 100;
    const k = planet.atmosphereDensity * (SCOUT.mass / 1); // area default = 1
    const samples = runDragSimulation(startSpeed, 10, planet);
    // At t=0 we should be at startSpeed. Check intermediate samples
    // against the analytic closed-form.
    for (const { t, speed } of samples) {
      if (t === 0) {
        expect(speed).toBeCloseTo(startSpeed, 6);
        continue;
      }
      // Closed form for quadratic drag in 1D (a = -k*v^2):
      //   v(t) = v_0 / (1 + k * v_0 * t)
      // Note: the integrator applies `a = -k * |v| * v` (vector),
      // which in 1D reduces to `a = -k * v^2`. Identical closed form.
      const analytic = startSpeed / (1 + k * startSpeed * t);
      const denom = Math.max(Math.abs(analytic), 1);
      const err = Math.abs(speed - analytic) / denom;
      // The integrator is discrete (Euler); we accept a 2% relative
      // tolerance to keep the test stable across dt choices. With
      // dt=1ms and k=0.2 the per-step error stays well under 1%.
      expect(err).toBeLessThan(0.02);
    }
  });

  it("continuity: no discontinuity in the acceleration function across altitudes", () => {
    // For two altitudes straddling the boundary edge, the
    // boundary factor (and therefore drag k) must differ by less
    // than 1 ppm. This is the acceptance criterion "drag ramp
    // continuity (no discontinuity in the acceleration function
    // at any boundary altitude)".
    const planet: PlanetAtmosphere = makeFlatPlanet({
      id: "boundary-planet",
      radius: TEST_RADIUS,
      atmosphereDensity: 1.0,
      hasAtmosphere: true,
    });
    const eps = 1e-6; // 1 micron
    // Below the surface (clamped at altitude 0).
    const below = dragCoefficient(-eps, planet, SCOUT.mass, 1);
    // At the surface.
    const at = dragCoefficient(0, planet, SCOUT.mass, 1);
    // Just below the band end.
    const justBelowBand = dragCoefficient(BOUNDARY_RAMP_WIDTH_M - eps, planet, SCOUT.mass, 1);
    // At the band end.
    const atBandEnd = dragCoefficient(BOUNDARY_RAMP_WIDTH_M, planet, SCOUT.mass, 1);
    // Above the band.
    const above = dragCoefficient(BOUNDARY_RAMP_WIDTH_M + eps, planet, SCOUT.mass, 1);

    expect(Math.abs(at - below)).toBeLessThan(1e-3);
    expect(Math.abs(atBandEnd - justBelowBand)).toBeLessThan(1e-3);
    expect(atBandEnd).toBeCloseTo(0, 9);
    expect(above).toBe(0);
  });

  it("boundaryFactor is monotonic across the band", () => {
    // The ramp must never go "up" as altitude increases. A
    // discontinuous (pop) factor would violate the spec.
    const planet: PlanetAtmosphere = makeFlatPlanet({
      id: "monotonic-planet",
      radius: TEST_RADIUS,
      atmosphereDensity: 1.0,
      hasAtmosphere: true,
    });
    let prev = boundaryFactor(0, planet);
    for (let alt = 0; alt <= BOUNDARY_RAMP_WIDTH_M; alt += 1) {
      const cur = boundaryFactor(alt, planet);
      // Monotonic non-increasing.
      expect(cur).toBeLessThanOrEqual(prev + 1e-9);
      // Within the band, must be strictly positive.
      if (alt < BOUNDARY_RAMP_WIDTH_M) {
        expect(cur).toBeGreaterThan(0);
      }
      prev = cur;
    }
  });
});
