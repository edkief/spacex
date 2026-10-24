import { describe, it, expect } from 'vitest';
import { integrateShip } from './flight';
import { ShipClass } from '../ships';
import { Planet, ShipState, FlightInput } from './types';
import { vec3, quat } from './vec';
import trajectoryFixture from './__fixtures__/trajectory.json';

const MOCK_SHIP: ShipClass = {
  id: 'scout',
  name: 'Scout',
  description: 'test',
  mass: 20,
  maxVelocity: 120,
  acceleration: 40,
  turnRate: 0.8,
  cargoSlots: 4,
  maxWeight: 40,
  weaponMounts: { laser: 1, missiles: 0 },
  shieldCapacity: 50,
  hull: 100,
  repairCostPerPoint: 10,
  price: 0,
  liverySlots: 3,
};

const MOCK_PLANET: Planet = {
  id: 'test-planet',
  atmosphereDensity: 1.225,
  radiusKm: 6371,
  atmosphereHeight: 100,
};

describe('integrateShip', () => {
  it('should maintain determinism (same input -> same output)', () => {
    const state: ShipState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 10, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    };
    const input: FlightInput = { thrust: 1, pitch: 0.1, yaw: 0.1, roll: 0.1, up: false };
    const dt = 0.05;

    const res1 = integrateShip(state, input, dt, 'space', MOCK_SHIP, undefined);
    const res2 = integrateShip(state, input, dt, 'space', MOCK_SHIP, undefined);

    expect(res1).toEqual(res2);
  });

  it('should move in a straight line in space with constant thrust', () => {
    let state: ShipState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    };
    const input: FlightInput = { thrust: 1, pitch: 0, yaw: 0, roll: 0, up: false };
    const dt = 1.0;

    // Accel = 40, mass = 20. a = 40/20 = 2? 
    // No, the code does: accelVec = forward * input.thrust * shipClass.acceleration
    // And then: currentVel = vec3.add(currentVel, vec3.scale(accel, dt))
    // Wait, the code I wrote is: accel = vec3.add(accel, thrustForce); currentVel = vec3.add(currentVel, vec3.scale(accel, dt));
    // So a = acceleration = 40 u/s^2.
    // After 1s, vel should be 40. pos should be 40 * 1 = 40?
    // Actually, it's Euler integration: vel = 0 + 40*1 = 40; pos = 0 + 40*1 = 40.
    
    state = integrateShip(state, input, dt, 'space', MOCK_SHIP);
    expect(state.vel.z).toBeCloseTo(40);
    expect(state.pos.z).toBeCloseTo(40);
  });

  it('should enforce soft speed cap in space', () => {
    let state: ShipState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: MOCK_SHIP.maxVelocity + 10 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    };
    const input: FlightInput = { thrust: 0, pitch: 0, yaw: 0, roll: 0, up: false };
    const dt = 0.05;

    state = integrateShip(state, input, dt, 'space', MOCK_SHIP);
    
    // MaxVel = 120. CurrentVel = 130.
    // excess = 10. newVel = 120 + 10 * 0.95 = 129.5.
    expect(state.vel.z).toBeCloseTo(129.5);
  });

  it('should reach terminal velocity in atmosphere', () => {
    // In atmosphere, drag = -k * |v| * v
    // Term velocity: thrust = drag
    // thrust = mass * acceleration = 20 * 40 = 800
    // drag = k * v^2 = (1.225 * 20 * 0.05) * v^2 = 1.225 * v^2
    // v^2 = 800 / 1.225 approx 653 -> v approx 25.5
    
    let state: ShipState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    const input: FlightInput = { thrust: 1, pitch: 0, yaw: 0, roll: 0, up: false };
    const dt = 0.1;

    // Simulate for a while to reach terminal velocity
    for (let i = 0; i < 1000; i++) {
      state = integrateShip(state, input, dt, 'atmosphere', MOCK_SHIP, MOCK_PLANET);
    }

    expect(state.vel.z).toBeCloseTo(25.5, 0);
  });

  it('should handle ground collision', () => {
    const state: ShipState = {
      pos: { x: 0, y: 1, z: 0 },
      vel: { x: 0, y: -100, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    const input: FlightInput = { thrust: 0, pitch: 0, yaw: 0, roll: 0, up: false };
    const dt = 0.1;
    const options: FlightOptions = { heightAt: () => 0 };

    const res = integrateShip(state, input, dt, 'atmosphere', MOCK_SHIP, MOCK_PLANET, options);
    
    expect(res.pos.y).toBe(0);
    expect(res.vel.y).toBe(0);
  });

  it('should VTOL hover convergence', () => {
    let state: ShipState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: -1, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    const input: FlightInput = { thrust: 0, pitch: 0, yaw: 0, roll: 0, up: true };
    const dt = 0.1;
    const options: FlightOptions = { heightAt: () => 0 };

    // Simulate for a few seconds
    for (let i = 0; i < 50; i++) {
      state = integrateShip(state, input, dt, 'atmosphere', MOCK_SHIP, MOCK_PLANET, options);
    }

    expect(state.vel.y).toBeGreaterThan(0);
    expect(state.pos.y).toBeGreaterThan(0);
  });

  it('should throw on unknown regime', () => {
    const state: ShipState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    };
    const input: FlightInput = { thrust: 0, pitch: 0, yaw: 0, roll: 0, up: false };
    
    // @ts-expect-error: testing runtime error for invalid regime
    expect(() => integrateShip(state, input, 0.1, 'invalid', MOCK_SHIP, undefined)).toThrow();
  });

  it('should match golden trajectory fixture', () => {
    let state: ShipState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    };
    const input: FlightInput = { thrust: 1, pitch: 0.1, yaw: 0.1, roll: 0.1, up: false };
    const dt = 0.05;

    for (let i = 0; i < trajectoryFixture.length; i++) {
      state = integrateShip(state, input, dt, 'space', MOCK_SHIP);
      const expected = trajectoryFixture[i];
      
      expect(state.pos.x).toBeCloseTo(expected.pos.x, 5);
      expect(state.pos.y).toBeCloseTo(expected.pos.y, 5);
      expect(state.pos.z).toBeCloseTo(expected.pos.z, 5);
      expect(state.vel.x).toBeCloseTo(expected.vel.x, 5);
      expect(state.vel.y).toBeCloseTo(expected.vel.y, 5);
      expect(state.vel.z).toBeCloseTo(expected.vel.z, 5);
    }
  });
});
