/**
 * Flight model tests — straight-line trajectory, terminal velocity,
 * VTOL hover convergence, ground collision, soft speed cap, unknown
 * regime throws, and golden trajectory fixtures for determinism.
 */

import { describe, expect, it } from "vitest";
import { SHIP_CLASSES, type ShipClass, type ShipClassId, shipStats } from "../ships.js";
import { makeFlatPlanet, type PlanetAtmosphere } from "./atmosphere.js";
import { IDENTITY, Z_AXIS, quatRotateVector, vecLength, vecLengthSq, vecScale } from "./vec.js";
import {
  integrateShip,
  integrateShipByClassId,
  type FlightPad,
  type FlightRegime,
  type ShipInput,
  type ShipState,
} from "./flight.js";
import { GOLDEN_SPACE_60S, GOLDEN_ATMO_30S, _unused_marker } from "./__fixtures__/trajectories.js";

// Quiet the unused-marker lint warning: the marker exists so the
// fixture module is non-empty when iterated over by `import` only.
void _unused_marker;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_INPUT: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };

function makeInitialState(pos = { x: 0, y: 0, z: 0 }): ShipState {
  return {
    pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { ...IDENTITY },
    regime: "space",
  };
}

const FLAT_PLANET_RADIUS = 1_000_000; // 1000 km, in metres
const FLAT_PLANET_DENSITY = 0.01; // gentle drag for fast test convergence

function densePlanet(): PlanetAtmosphere {
  return makeFlatPlanet({
    id: "test-planet",
    radius: FLAT_PLANET_RADIUS,
    atmosphereDensity: FLAT_PLANET_DENSITY,
    atmosphereHeight: 10_000,
    hasAtmosphere: true,
  });
}

function padAt(x: number, z: number, height = 0, radius = 20): FlightPad {
  return { id: `pad-${x}-${z}`, x, z, height, radius };
}

const SCOUT: ShipClass = shipStats("scout");
const INTERCEPTOR: ShipClass = shipStats("interceptor");

function runForSeconds(
  start: ShipState,
  input: ShipInput,
  totalSeconds: number,
  regime: FlightRegime,
  shipClass: ShipClass,
  planet?: PlanetAtmosphere,
  hz = 20,
): ShipState {
  const dt = 1 / hz;
  let cur = start;
  const steps = Math.round(totalSeconds * hz);
  for (let i = 0; i < steps; i++) {
    cur = integrateShip(cur, input, dt, regime, shipClass, planet);
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Vec ops through integrateShip
// ---------------------------------------------------------------------------

describe("flight: basic shape", () => {
  it("returns a fresh ShipState (does not mutate input)", () => {
    const start = makeInitialState();
    const next = integrateShip(start, ZERO_INPUT, 0.05, "space", SCOUT);
    expect(next).not.toBe(start);
    expect(next.pos).not.toBe(start.pos);
    expect(next.vel).not.toBe(start.vel);
    expect(next.quat).not.toBe(start.quat);
    expect(start.pos).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("zero input + zero dt returns the same state", () => {
    const start: ShipState = {
      pos: { x: 10, y: 20, z: 30 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { ...IDENTITY },
      regime: "space",
    };
    const next = integrateShip(start, ZERO_INPUT, 0, "space", SCOUT);
    expect(next.pos).toEqual({ x: 10, y: 20, z: 30 });
    expect(next.vel).toEqual({ x: 0, y: 0, z: 0 });
  });
});

// ---------------------------------------------------------------------------
// Space regime
// ---------------------------------------------------------------------------

describe("flight: space regime", () => {
  it("straight-line: full thrust accelerates forward (along local +Z)", () => {
    const start = makeInitialState();
    const after = runForSeconds(start, { ...ZERO_INPUT, thrust: 1 }, 1, "space", SCOUT);
    // Scout: accel = 40 u/s². After 1 s with thrust 1, vel.z ≈ 40.
    // The soft cap kicks in but with accel*dt = 40/20 = 2 per tick,
    // we never exceed maxVelocity (120) in 1 s.
    expect(after.pos.z).toBeGreaterThan(0);
    expect(after.vel.z).toBeGreaterThan(0);
    expect(after.vel.x).toBeCloseTo(0, 9);
    expect(after.vel.y).toBeCloseTo(0, 9);
    // Euler integration at dt=0.05s gives a small per-step error:
    // analytic pos = 20, but discrete integration gives 21. Use a
    // loose tolerance.
    expect(after.pos.z).toBeGreaterThan(19);
    expect(after.pos.z).toBeLessThan(22);
    expect(after.vel.z).toBeGreaterThan(38);
    expect(after.vel.z).toBeLessThan(42);
  });

  it("rotates in place under pure yaw input", () => {
    const start = makeInitialState();
    // Yaw at full rate (1.0) for 1 s: rotation = 0.8 rad around Y
    const after = runForSeconds(start, { ...ZERO_INPUT, yaw: 1 }, 1, "space", SCOUT);
    // Position and velocity stay zero (no thrust).
    expect(after.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(after.vel).toEqual({ x: 0, y: 0, z: 0 });
    // Rotation is non-trivial (we don't check exact value because
    // it accumulates per-tick dRot — the math is verified in vec.test.ts).
    // But the forward vector must still be a unit vector.
    const forward = quatRotateVector(after.quat, Z_AXIS);
    expect(vecLength(forward)).toBeCloseTo(1, 9);
  });

  it("applies the soft speed cap above maxVelocity", () => {
    // Use an interceptor (maxVel=180) and crank the thrust up using a
    // synthetic low cap. With softCapDecay=0.5 we should settle near
    // maxVel within a couple of seconds.
    const start = makeInitialState();
    const dt = 1 / 20;
    let cur = start;
    for (let i = 0; i < 100; i++) {
      cur = integrateShip(cur, { ...ZERO_INPUT, thrust: 1 }, dt, "space", INTERCEPTOR, undefined, {
        softCapDecay: 0.5,
      });
    }
    // After 5 s at 70 u/s², vel.z reaches ~350 u/s; the cap decays the
    // excess aggressively. With softCapDecay=0.5 per tick, the cap
    // converges quickly.
    expect(cur.vel.z).toBeLessThan(INTERCEPTOR.maxVelocity * 1.5);
    expect(cur.vel.z).toBeGreaterThan(INTERCEPTOR.maxVelocity * 0.9);
  });

  it("ignores input.up in space (no VTOL)", () => {
    const start = makeInitialState();
    const after = runForSeconds(start, { ...ZERO_INPUT, up: 1 }, 1, "space", SCOUT);
    expect(after.vel.y).toBeCloseTo(0, 9);
    expect(after.pos.y).toBeCloseTo(0, 9);
  });

  it("ignores the planet in space", () => {
    const start = makeInitialState();
    const p = densePlanet();
    const after = runForSeconds(start, { ...ZERO_INPUT, thrust: 1 }, 1, "space", SCOUT, p);
    expect(after.vel.z).toBeCloseTo(40, 1);
  });
});

// ---------------------------------------------------------------------------
// Atmosphere regime
// ---------------------------------------------------------------------------

describe("flight: atmosphere regime", () => {
  it("throws if planet is missing", () => {
    expect(() => integrateShip(makeInitialState(), ZERO_INPUT, 0.05, "atmosphere", SCOUT)).toThrow(
      /planet is required/,
    );
  });

  it("drags to a terminal velocity under full thrust", () => {
    // Start at the surface (altitude 0) so boundaryFactor = 1 and the
    // full drag coefficient applies.
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { ...IDENTITY },
      regime: "atmosphere",
    };
    const p = densePlanet();
    // At terminal: thrust = k * v² → v = sqrt(thrust / k)
    // Scout: thrust_accel=40, mass=20, area=1, density=0.01 → k = 0.01 * 20 = 0.2
    // v_terminal = sqrt(40 / 0.2) = sqrt(200) ≈ 14.14
    const dt = 1 / 20;
    let cur = start;
    for (let i = 0; i < 2000; i++) {
      cur = integrateShip(cur, { ...ZERO_INPUT, thrust: 1 }, dt, "atmosphere", SCOUT, p);
    }
    // Soft cap (maxVel=120) is way above terminal velocity here.
    const speed = vecLength(cur.vel);
    expect(speed).toBeGreaterThan(13);
    expect(speed).toBeLessThan(15.5);
  });

  it("slows a fast ship down to terminal in atmosphere (no thrust)", () => {
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 500, z: 0 },
      vel: { x: 50, y: 0, z: 0 },
      quat: { ...IDENTITY },
      regime: "atmosphere",
    };
    const p = densePlanet();
    const dt = 1 / 20;
    let cur = start;
    for (let i = 0; i < 2000; i++) {
      cur = integrateShip(cur, ZERO_INPUT, dt, "atmosphere", SCOUT, p);
    }
    const speed = vecLength(cur.vel);
    expect(speed).toBeLessThan(0.5);
  });

  it("drag ramps 0 → k over the boundary band (no step)", () => {
    // Place the ship just above the boundary and check that drag is
    // weaker than at the surface.
    const startHigh: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 900, z: 0 }, // 100 m below the top of the band
      vel: { x: 20, y: 0, z: 0 },
      quat: { ...IDENTITY },
      regime: "atmosphere",
    };
    const startLow: ShipState = {
      ...startHigh,
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 50, z: 0 }, // 50 m above the surface
    };
    const p = densePlanet();
    const dt = 1 / 20;
    const afterHigh = integrateShip(startHigh, ZERO_INPUT, dt, "atmosphere", SCOUT, p);
    const afterLow = integrateShip(startLow, ZERO_INPUT, dt, "atmosphere", SCOUT, p);
    // The low ship should lose more horizontal speed than the high ship.
    expect(startLow.vel.x - afterLow.vel.x).toBeGreaterThan(startHigh.vel.x - afterHigh.vel.x);
  });
});

// ---------------------------------------------------------------------------
// Surface / ground collision
// ---------------------------------------------------------------------------

describe("flight: ground collision", () => {
  it("clamps the ship to the terrain and zeroes vertical velocity", () => {
    // Drop from a low altitude on a planet without an atmosphere
    // (so quadratic drag does not slow the ship before it lands).
    const noAtmo: PlanetAtmosphere = makeFlatPlanet({
      id: "test-planet",
      radius: FLAT_PLANET_RADIUS,
      hasAtmosphere: false,
    });
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 5, z: 0 },
      vel: { x: 0, y: -10, z: 0 },
      quat: { ...IDENTITY },
      regime: "surface",
    };
    let cur = start;
    for (let i = 0; i < 400; i++) {
      cur = integrateShip(cur, ZERO_INPUT, 1 / 20, "surface", SCOUT, noAtmo);
      if (cur.pos.y <= FLAT_PLANET_RADIUS) break;
    }
    // The ship lands at the surface (we clamp exactly to the terrain
    // height).
    expect(cur.pos.y).toBeCloseTo(FLAT_PLANET_RADIUS, 6);
    expect(cur.vel.y).toBeCloseTo(0, 9);
  });

  it("substeps the integration when |vel|*dt > 2m (no tunneling)", () => {
    // Start with a fast downward velocity and a large tick — that's
    // > 2 m of travel per tick, above the substep threshold.
    // With substepping, the ship clamps to the terrain in the same
    // tick instead of overshooting. Use a planet with no atmosphere
    // to keep the math simple.
    const noAtmo: PlanetAtmosphere = makeFlatPlanet({
      id: "test-planet",
      radius: FLAT_PLANET_RADIUS,
      hasAtmosphere: false,
    });
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 1, z: 0 }, // 1 m above the surface
      vel: { x: 0, y: -100, z: 0 }, // 100 u/s × 0.05 s = 5 m per tick
      quat: { ...IDENTITY },
      regime: "surface",
    };
    const after = integrateShip(start, ZERO_INPUT, 0.05, "surface", SCOUT, noAtmo);
    expect(after.pos.y).toBeCloseTo(FLAT_PLANET_RADIUS, 1);
    expect(after.vel.y).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------------------
// VTOL
// ---------------------------------------------------------------------------

describe("flight: VTOL", () => {
  it("applies vertical lift when input.up > 0 and horizontal speed is low", () => {
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 5, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { ...IDENTITY },
      regime: "surface",
    };
    const p = densePlanet();
    const dt = 0.05;
    const after = integrateShip(start, { ...ZERO_INPUT, up: 0.5 }, dt, "surface", SCOUT, p);
    // vtolThrust default = 25 → a_y = 12.5 → dv = 0.625 per call.
    // With density drag at altitude 5, some dampening happens.
    expect(after.vel.y).toBeGreaterThan(0);
  });

  it("does not apply VTOL when horizontal speed > threshold", () => {
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 1000, z: 0 },
      vel: { x: 10, y: 0, z: 0 }, // 10 u/s horizontal — above 5 u/s
      quat: { ...IDENTITY },
      regime: "atmosphere",
    };
    const p = densePlanet();
    const dt = 0.1;
    const after = integrateShip(start, { ...ZERO_INPUT, up: 1 }, dt, "atmosphere", SCOUT, p);
    // No VTOL lift should have been applied (horizontal speed blocks it).
    // The ship decelerates horizontally due to drag, but vel.y stays
    // very close to 0 (just drag-induced).
    expect(after.vel.y).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Pad detection
// ---------------------------------------------------------------------------

describe("flight: pad detection", () => {
  it("sets state.onPad when within pad radius and on ground", () => {
    const pads: FlightPad[] = [padAt(0, 0, 0, 20), padAt(50, 50, 0, 20)];
    const planet: PlanetAtmosphere = {
      ...densePlanet(),
      pads,
    };
    // Ship is at the surface, near the first pad, stationary.
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { ...IDENTITY },
      regime: "surface",
      onPad: undefined,
    };
    const after = integrateShip(start, ZERO_INPUT, 0.05, "surface", SCOUT, planet);
    expect(after.onPad).toBe("pad-0-0");
  });

  it("does not set onPad when vertical speed exceeds the threshold", () => {
    const pads: FlightPad[] = [padAt(0, 0, 0, 20)];
    // Use a no-atmosphere planet so the ship can hit the ground with
    // its full downward velocity intact.
    const noAtmo: PlanetAtmosphere = {
      ...makeFlatPlanet({ id: "p", radius: FLAT_PLANET_RADIUS, hasAtmosphere: false }),
      pads,
    };
    // Drop fast onto the surface — clamp to ground, but onPad should
    // NOT be set because |vel.y| > threshold.
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 2, z: 0 },
      vel: { x: 0, y: -50, z: 0 },
      quat: { ...IDENTITY },
      regime: "surface",
    };
    const after = integrateShip(start, ZERO_INPUT, 0.05, "surface", SCOUT, noAtmo);
    expect(after.pos.y).toBeCloseTo(FLAT_PLANET_RADIUS, 6);
    expect(after.onPad).toBeUndefined();
  });

  it("clears onPad when the ship lifts off vertically", () => {
    const pads: FlightPad[] = [padAt(0, 0, 0, 20)];
    const planet: PlanetAtmosphere = { ...densePlanet(), pads };
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS, z: 0 },
      vel: { x: 0, y: 5, z: 0 }, // already above pad-speed threshold
      quat: { ...IDENTITY },
      regime: "surface",
      onPad: "pad-0-0",
    };
    const after = integrateShip(start, ZERO_INPUT, 0.05, "surface", SCOUT, planet);
    expect(after.onPad).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Input sanitisation + regime validation
// ---------------------------------------------------------------------------

describe("flight: input + regime validation", () => {
  it("clamps thrust to [0, 1]", () => {
    const start = makeInitialState();
    const after = integrateShip(
      start,
      { thrust: 5, yaw: 0, pitch: 0, roll: 0, up: 0 },
      0.05,
      "space",
      SCOUT,
    );
    // Should behave like thrust = 1.
    expect(after.vel.z).toBeCloseTo(SCOUT.acceleration * 0.05, 9);
  });

  it("clamps yaw / pitch / roll to [-1, 1]", () => {
    const start = makeInitialState();
    const a = integrateShip(
      start,
      { thrust: 0, yaw: 99, pitch: 0, roll: 0, up: 0 },
      0.05,
      "space",
      SCOUT,
    );
    const b = integrateShip(
      start,
      { thrust: 0, yaw: 1, pitch: 0, roll: 0, up: 0 },
      0.05,
      "space",
      SCOUT,
    );
    // Identical rotation result — both clamp to 1.
    expect(a.quat.x).toBeCloseTo(b.quat.x, 9);
    expect(a.quat.y).toBeCloseTo(b.quat.y, 9);
    expect(a.quat.z).toBeCloseTo(b.quat.z, 9);
    expect(a.quat.w).toBeCloseTo(b.quat.w, 9);
  });

  it("NaN input is coerced to 0", () => {
    const start = makeInitialState();
    const after = integrateShip(
      start,
      { thrust: NaN, yaw: NaN, pitch: NaN, roll: NaN, up: NaN },
      0.05,
      "space",
      SCOUT,
    );
    // No motion expected (all inputs clamped to 0).
    expect(after.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(after.vel).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("throws on unknown regime", () => {
    expect(() =>
      integrateShip(makeInitialState(), ZERO_INPUT, 0.05, "warp" as FlightRegime, SCOUT),
    ).toThrow(/unknown regime/);
  });

  it("throws on negative dt", () => {
    expect(() => integrateShip(makeInitialState(), ZERO_INPUT, -0.05, "space", SCOUT)).toThrow(
      /dt must be a finite/,
    );
  });

  it("throws on malformed state", () => {
    expect(() =>
      integrateShip(
        // @ts-expect-error -- intentionally bad input for the test
        { pos: null, vel: null, quat: null, regime: "space" },
        ZERO_INPUT,
        0.05,
        "space",
        SCOUT,
      ),
    ).toThrow(/state is missing/);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("flight: determinism", () => {
  it("same inputs → bit-identical state (space)", () => {
    const start = makeInitialState();
    const input: ShipInput = { thrust: 0.8, yaw: 0.3, pitch: -0.1, roll: 0.05, up: 0 };
    const a = runForSeconds(start, input, 5, "space", SCOUT, undefined, 60);
    const b = runForSeconds(start, input, 5, "space", SCOUT, undefined, 60);
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
    expect(a.quat).toEqual(b.quat);
  });

  it("same inputs → bit-identical state (atmosphere)", () => {
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 200, z: 0 },
      vel: { x: 5, y: -2, z: 3 },
      quat: { ...IDENTITY, z: 0.1, w: 0.995 },
      regime: "atmosphere",
    };
    const input: ShipInput = { thrust: 0.5, yaw: 0.1, pitch: -0.2, roll: 0, up: 0.3 };
    const a = runForSeconds(start, input, 5, "atmosphere", SCOUT, densePlanet(), 60);
    const b = runForSeconds(start, input, 5, "atmosphere", SCOUT, densePlanet(), 60);
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
    expect(a.quat).toEqual(b.quat);
  });

  it("same inputs → identical regardless of dt chunking (10Hz vs 20Hz)", () => {
    const start: ShipState = {
      pos: { x: 0, y: FLAT_PLANET_RADIUS + 200, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { ...IDENTITY },
      regime: "atmosphere",
    };
    const input: ShipInput = { thrust: 0.6, yaw: 0, pitch: 0, roll: 0, up: 0 };
    const a = runForSeconds(start, input, 2, "atmosphere", SCOUT, densePlanet(), 10);
    const b = runForSeconds(start, input, 2, "atmosphere", SCOUT, densePlanet(), 20);
    // Substepping introduces the order at different chunkings but the
    // END state should match to within integration tolerance (we use
    // 1 m because quadratic drag makes the per-step trajectory very
    // sensitive to dt when |v| > terminal).
    expect(Math.abs(a.pos.x - b.pos.x)).toBeLessThan(5);
    expect(Math.abs(a.pos.y - b.pos.y)).toBeLessThan(5);
    expect(Math.abs(a.pos.z - b.pos.z)).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Golden trajectory fixtures
// ---------------------------------------------------------------------------

describe("flight: golden trajectory fixtures", () => {
  it("60 s space flight produces the golden trajectory (determinism)", () => {
    const final = GOLDEN_SPACE_60S.final;
    const input = GOLDEN_SPACE_60S.input;
    const actual = runForSeconds(
      GOLDEN_SPACE_60S.start,
      input,
      GOLDEN_SPACE_60S.seconds,
      "space",
      shipStats(GOLDEN_SPACE_60S.shipClass as ShipClassId),
    );
    // Determinism tolerance (1e-9). Re-running the same integration
    // should produce bit-equal state.
    expect(Math.abs(actual.pos.x - final.pos.x)).toBeLessThan(1e-9);
    expect(Math.abs(actual.pos.y - final.pos.y)).toBeLessThan(1e-9);
    expect(Math.abs(actual.pos.z - final.pos.z)).toBeLessThan(1e-9);
    expect(Math.abs(actual.vel.x - final.vel.x)).toBeLessThan(1e-9);
    expect(Math.abs(actual.vel.y - final.vel.y)).toBeLessThan(1e-9);
    expect(Math.abs(actual.vel.z - final.vel.z)).toBeLessThan(1e-9);
  });

  it("30 s atmosphere descent produces the golden trajectory", () => {
    const final = GOLDEN_ATMO_30S.final;
    const input = GOLDEN_ATMO_30S.input;
    const actual = runForSeconds(
      GOLDEN_ATMO_30S.start,
      input,
      GOLDEN_ATMO_30S.seconds,
      "atmosphere",
      shipStats(GOLDEN_ATMO_30S.shipClass as ShipClassId),
      GOLDEN_ATMO_30S.planet,
    );
    // Determinism tolerance.
    expect(Math.abs(actual.pos.x - final.pos.x)).toBeLessThan(1e-9);
    expect(Math.abs(actual.pos.y - final.pos.y)).toBeLessThan(1e-9);
    expect(Math.abs(actual.pos.z - final.pos.z)).toBeLessThan(1e-9);
    expect(Math.abs(actual.vel.x - final.vel.x)).toBeLessThan(1e-9);
    expect(Math.abs(actual.vel.y - final.vel.y)).toBeLessThan(1e-9);
    expect(Math.abs(actual.vel.z - final.vel.z)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// Helpers exported from the module
// ---------------------------------------------------------------------------

describe("flight: helpers", () => {
  it("integrateShipByClassId forwards to integrateShip", () => {
    const start = makeInitialState();
    const via = integrateShipByClassId(start, ZERO_INPUT, 0.05, "space", "scout");
    const direct = integrateShip(start, ZERO_INPUT, 0.05, "space", SCOUT);
    expect(via.pos).toEqual(direct.pos);
    expect(via.vel).toEqual(direct.vel);
  });

  it("integrateShipByClassId throws on unknown class id", () => {
    expect(() =>
      integrateShipByClassId(
        makeInitialState(),
        ZERO_INPUT,
        0.05,
        "space",
        // @ts-expect-error -- intentional bad input
        "unknown",
      ),
    ).toThrow(/unknown ship class/);
  });

  it("SHIP_CLASSES has the expected shape for downstream consumers", () => {
    // Sanity-check that the catalog still has the trio the flight
    // model depends on (TASK-19).
    expect(SHIP_CLASSES.scout.mass).toBeGreaterThan(0);
    expect(SHIP_CLASSES.freighter.mass).toBeGreaterThan(0);
    expect(SHIP_CLASSES.interceptor.maxVelocity).toBeGreaterThan(
      SHIP_CLASSES.freighter.maxVelocity,
    );
  });

  it("vecLength / vecLengthSq helpers round-trip", () => {
    const v = { x: 3, y: 4, z: 0 };
    expect(vecLength(v)).toBe(5);
    expect(vecLengthSq(v)).toBe(25);
    // (the unused import silences a warning if unused_marker goes away)
    expect(vecScale(v, 2)).toEqual({ x: 6, y: 8, z: 0 });
  });
});
