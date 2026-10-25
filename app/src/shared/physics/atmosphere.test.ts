import { describe, it, expect } from 'vitest';
import { boundaryFactor } from './atmosphere';
import { Planet } from './types';
import { integrateShip } from './flight';
import { SHIP_CLASSES } from '../ships';
import { vec3 } from './vec';

describe('Atmosphere Boundary Factor', () => {
  const mockPlanet: Planet = {
    id: 'p-1',
    radiusKm: 1000,
    atmosphereHeight: 100, // 100km
    atmosphereDensity: 0.5,
  };

  it('should be 1 at surface', () => {
    expect(boundaryFactor(0, mockPlanet)).toBe(1);
  });

  it('should be 1 well within atmosphere', () => {
    expect(boundaryFactor(10 * 1000, mockPlanet)).toBe(1);
  });

  it('should be 0 above atmosphere height', () => {
    expect(boundaryFactor(101 * 1000, mockPlanet)).toBe(0);
  });

  it('should ramp linearly over the last 1km', () => {
    const altStart = 99 * 1000; // 1km below boundary
    const altMid = 99.5 * 1000;
    const altEnd = 100 * 1000;

    expect(boundaryFactor(altStart, mockPlanet)).toBe(1);
    expect(boundaryFactor(altMid, mockPlanet)).toBeCloseTo(0.5);
    expect(boundaryFactor(altEnd, mockPlanet)).toBe(0);
  });

  it('should return 0 if planet has no atmosphere', () => {
    const noAtmoPlanet: Planet = { ...mockPlanet, atmosphereHeight: 0 };
    expect(boundaryFactor(0, noAtmoPlanet)).toBe(0);
    expect(boundaryFactor(10 * 1000, noAtmoPlanet)).toBe(0);
  });

  it('should be continuous (no jumps)', () => {
    for (let alt = 0; alt < 110000; alt += 10) {
      const f1 = boundaryFactor(alt, mockPlanet);
      const f2 = boundaryFactor(alt + 10, mockPlanet);
      expect(Math.abs(f1 - f2)).toBeLessThanOrEqual(0.1); // linear ramp is 1/1000 per meter
    }
  });
});

describe('Atmosphere Simulation Integration', () => {
  it('should match analytic drag curve within 2% when deep in atmosphere', () => {
    const planet: Planet = {
      id: 'p-1',
      radiusKm: 1000,
      atmosphereHeight: 100,
      atmosphereDensity: 0.5,
    };
    const shipClass = SHIP_CLASSES.scout;
    const v0 = 100;
    const dt = 0.05;
    const duration = 10;
    
    // Initial state: deep in atmosphere (alt = 10km)
    // pos = [0, radius + 10km, 0]
    let state: any = {
      pos: { x: 0, y: planet.radiusKm * 1000 + 10000, z: 0 },
      vel: { x: 0, y: -v0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
      onPad: false,
    };

    // Integrate for 10 seconds
    for (let t = 0; t < duration; t += dt) {
      state = integrateShip(
        state,
        { thrust: 0, pitch: 0, yaw: 0, roll: 0, up: 0, fire: false, lock: false },
        dt,
        'atmosphere',
        shipClass,
        planet
      );
    }

    const finalVel = Math.abs(state.vel.y);
    
    // Analytic solution: v(t) = v0 / (1 + v0 * C * t)
    // C = (atmosphereDensity * area) / mass
    // area = mass * 0.05
    // C = atmosphereDensity * 0.05
    const C = planet.atmosphereDensity * 0.05;
    const vAnalytic = v0 / (1 + v0 * C * duration);
    
    const error = Math.abs(finalVel - vAnalytic) / vAnalytic;
    expect(error).toBeLessThan(0.02);
  });

  it('should apply drag ramp correctly when entering atmosphere', () => {
    const planet: Planet = {
      id: 'p-1',
      radiusKm: 1000,
      atmosphereHeight: 100,
      atmosphereDensity: 0.5,
    };
    const shipClass = SHIP_CLASSES.scout;
    const v0 = 100;
    const dt = 0.1;
    
    // Start just above the atmosphere
    let state: any = {
      pos: { x: 0, y: planet.radiusKm * 1000 + 100 * 1000 + 10, z: 0 },
      vel: { x: 0, y: -v0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
      onPad: false,
    };

    // Integrate one step
    const nextState = integrateShip(
      state,
      { thrust: 0, pitch: 0, yaw: 0, roll: 0, up: 0, fire: false, lock: false },
      dt,
      'atmosphere',
      shipClass,
      planet
    );

    // At the start, alt = 100.01km, boundaryFactor = 0, so no drag.
    expect(nextState.vel.y).toBe(-v0);

    // Move state to middle of ramp (alt = 99.5km)
    state.pos.y = planet.radiusKm * 1000 + 99.5 * 1000;
    const rampState = integrateShip(
      state,
      { thrust: 0, pitch: 0, yaw: 0, roll: 0, up: 0, fire: false, lock: false },
      dt,
      'atmosphere',
      shipClass,
      planet
    );

    // Should have some drag now
    expect(Math.abs(rampState.vel.y)).toBeLessThan(v0);
  });
});
