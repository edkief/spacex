import { describe, expect, it } from 'vitest';
import {
  boundaryFactor,
  dragAcceleration,
  dragCoefficient,
  dragSpeedAt,
} from '@shared/physics/atmosphere.ts';
import { integrateShip } from '@shared/physics/flight.ts';
import { ATMOSPHERE_RAMP_M, SURFACE_GRAVITY } from '@shared/physics/flightConstants.ts';
import { IDLE, body, flatSurface, restingShip } from '@shared/physics/testkit.ts';
import { length } from '@shared/physics/vec.ts';
import { shipStats } from '@shared/ships/catalog.ts';
import { SHIP_CLASS_IDS } from '@shared/ships/ids.ts';

const TOP = body.atmosphere!.top;
const scout = shipStats('scout');
const ctx = (over: object = {}) => ({
  shipClass: scout,
  bodies: [body],
  surface: flatSurface(0),
  ...over,
});
const inAtmosphere = (y: number, vel: { x: number; y: number; z: number }) =>
  restingShip({ x: 0, y, z: 0 }, { frame: body.id, vel, regime: 'atmosphere' });

describe('atmosphere boundary factor', () => {
  it('is 0 at and above the top, 1 a kilometre below it, linear in between', () => {
    expect(boundaryFactor(TOP + 500, TOP)).toBe(0);
    expect(boundaryFactor(TOP, TOP)).toBe(0);
    expect(boundaryFactor(TOP - ATMOSPHERE_RAMP_M / 2, TOP)).toBeCloseTo(0.5, 12);
    expect(boundaryFactor(TOP - ATMOSPHERE_RAMP_M, TOP)).toBe(1);
    expect(boundaryFactor(0, TOP)).toBe(1);
    expect(boundaryFactor(100, 0)).toBe(0); // airless
  });

  it('is monotonic and continuous (no jump at any altitude)', () => {
    let previous = boundaryFactor(TOP + 50, TOP);
    for (let altitude = TOP + 50; altitude > TOP - 1200; altitude -= 0.25) {
      const factor = boundaryFactor(altitude, TOP);
      expect(factor).toBeGreaterThanOrEqual(previous);
      expect(factor - previous).toBeLessThan(0.0005);
      previous = factor;
    }
  });

  it('shrinks the ramp for atmospheres thinner than a kilometre', () => {
    expect(boundaryFactor(0, 500)).toBe(1);
    expect(boundaryFactor(250, 500)).toBeCloseTo(0.5, 12);
  });
});

describe('drag coefficient and curve', () => {
  it('scales with density and falls with mass; heavier ships fall faster', () => {
    expect(dragCoefficient(2, 20_000)).toBeCloseTo(2 * dragCoefficient(1, 20_000), 12);
    expect(dragCoefficient(1, 120_000)).toBeLessThan(dragCoefficient(1, 20_000));
    expect(length(dragAcceleration({ x: 0, y: 0, z: 0 }, 0.01))).toBe(0);
    const a = dragAcceleration({ x: 30, y: 0, z: 40 }, 0.01);
    expect(length(a)).toBeCloseTo(0.01 * 50 * 50, 9);
    expect(a.x).toBeLessThan(0);
  });

  it('matches the closed-form curve v0 / (1 + k v0 t) within 2% over 10 s (constant full drag)', () => {
    const k = dragCoefficient(1, scout.mass);
    let state = inAtmosphere(5000, { x: 100, y: 0, z: 0 });
    const c = ctx({ gravity: 0, assist: false });
    for (let step = 1; step <= 200; step++) {
      state = integrateShip(state, IDLE, 0.05, c);
      if (step % 20 === 0) {
        const t = step * 0.05;
        const analytic = dragSpeedAt(100, k, t);
        expect(Math.abs(state.vel.x - analytic) / analytic, `t=${t}`).toBeLessThan(0.02);
      }
    }
  });

  it('matches a high-resolution reference through the 1 km ramp within 2% (entering at 100 m/s)', () => {
    const run = (dt: number) => {
      let state = inAtmosphere(TOP + 20, { x: 100, y: -60, z: 0 });
      for (let t = 0; t < 10 - 1e-9; t += dt)
        state = integrateShip(state, IDLE, dt, ctx({ gravity: 0, assist: false }));
      return length(state.vel);
    };
    const coarse = run(0.05);
    const reference = run(0.001);
    expect(Math.abs(coarse - reference) / reference).toBeLessThan(0.02);
  });

  it('has terminal velocity sqrt(g / k) in free fall (about 60 m/s for the scout)', () => {
    let state = inAtmosphere(5000, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 1200; i++) state = integrateShip(state, IDLE, 0.05, ctx({ assist: false }));
    const k = dragCoefficient(1, scout.mass);
    expect(-state.vel.y).toBeCloseTo(Math.sqrt(SURFACE_GRAVITY / k), 0);
    expect(-state.vel.y).toBeGreaterThan(55);
    expect(-state.vel.y).toBeLessThan(65);
  });
});

describe('acceleration is continuous across the atmosphere boundary', () => {
  it.each(SHIP_CLASS_IDS)(
    '%s: no jump in total acceleration at any altitude around the top',
    (id) => {
      const cls = shipStats(id);
      const accelAt = (altitude: number): { x: number; y: number } => {
        const s = inAtmosphere(altitude, { x: 60, y: -50, z: 0 });
        const next = integrateShip(s, IDLE, 1e-4, {
          shipClass: cls,
          bodies: [body],
          surface: flatSurface(-1e9),
        });
        return { x: (next.vel.x - 60) / 1e-4, y: (next.vel.y + 50) / 1e-4 };
      };
      let previous = accelAt(TOP + 30);
      let worstJump = 0;
      for (let altitude = TOP + 30; altitude > TOP - 1100; altitude -= 0.5) {
        const a = accelAt(altitude);
        worstJump = Math.max(worstJump, Math.abs(a.x - previous.x), Math.abs(a.y - previous.y));
        previous = a;
      }
      // Gravity (9.8) and drag both ramp over 1 km: per 0.5 m the change is a few 0.01 m/s^2, never a step.
      expect(worstJump).toBeLessThan(0.2);
    },
  );

  it('applies neither gravity nor drag in open space above the atmosphere top', () => {
    const s = inAtmosphere(TOP + 40, { x: 60, y: 0, z: 0 });
    const next = integrateShip(s, IDLE, 0.05, ctx({ assist: false }));
    expect(next.vel).toEqual({ x: 60, y: 0, z: 0 });
  });
});
