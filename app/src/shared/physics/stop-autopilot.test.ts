import { describe, expect, it } from 'vitest';

import { shipStats } from '../ships';
import type { PlanetAtmo, ShipState } from './flight';
import { integrateShip } from './flight';
import { quatFromEuler, quatIdentity, vecLength, type Quat } from './vec';
import { STOP_SPEED_EPS, stopInput } from './stop-autopilot';

/**
 * TASK-109: the stop autopilot driven through the REAL integrateShip (20 Hz,
 * the server's dt). The acceptance bar is the stop TIMING:
 * - space, 120 u/s scout: < 15 s (all classes < 20 s);
 * - atmosphere, 30 u/s at 200 m: ends GROUNDED with |vel| < 0.5 in < 30 s;
 * - at rest: the zero-demand (idle) input;
 * - pure/deterministic: two identical runs deep-equal.
 *
 * The worst-case attitude (nose 180° off the velocity) is used throughout —
 * any friendlier start only helps the timing.
 */

const DT = 1 / 20;
/** A mid-strength gas-giant atmosphere (scout drag k ≈ 0.027 1/u). */
const ATMO: PlanetAtmo = { atmosphereDensity: 0.06, atmosphereRadius: 6000 };
/** Nose facing -X: 180° off a +X velocity (worst case). */
const WORST_QUAT: Quat = quatFromEuler(Math.PI, 0, 0);

/** Integrate one full stop run; returns the per-tick inputs + final state. */
function runStop(
  start: ShipState,
  cls: 'scout' | 'freighter' | 'interceptor',
  maxTicks: number,
  opts: { regime: 'space' | 'atmosphere' | 'surface'; planet?: PlanetAtmo; heightAt?: (x: number, z: number) => number },
  stopWhen?: (s: ShipState) => boolean,
): { inputs: { thrust: number; yaw: number; pitch: number; roll: number; up: number }[]; state: ShipState; ticks: number } {
  const clsStat = shipStats(cls);
  let s = start;
  const inputs: { thrust: number; yaw: number; pitch: number; roll: number; up: number }[] = [];
  let ticks = 0;
  for (; ticks < maxTicks; ticks++) {
    const input = stopInput(s, clsStat, DT, {
      regime: opts.regime,
      heightAt: opts.heightAt,
    });
    inputs.push(input);
    s = integrateShip(s, input, DT, opts.regime, opts.planet, clsStat);
    if (stopWhen?.(s)) break;
  }
  return { inputs, state: s, ticks };
}

/** Every demand within the flight-model contract (bounded, finite). */
function expectBounded(inputs: { thrust: number; yaw: number; pitch: number; roll: number; up: number }[]): void {
  for (const i of inputs) {
    for (const v of [i.thrust, i.yaw, i.pitch, i.roll, i.up]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  }
}

describe('TASK-109: stop autopilot (shared stopInput)', () => {
  it('space: a 120 u/s scout (worst-case nose) stops below STOP_SPEED_EPS in < 15 s', () => {
    const start: ShipState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 120, y: 0, z: 0 },
      quat: WORST_QUAT,
      regime: 'space',
    };
    const { inputs, state, ticks } = runStop(
      start,
      'scout',
      300,
      { regime: 'space' },
      (s) => vecLength(s.vel) < STOP_SPEED_EPS,
    );
    expectBounded(inputs);
    expect(ticks, `stopped at ${ticks / 20} s`).toBeLessThan(300); // < 15 s
    expect(vecLength(state.vel)).toBeLessThan(STOP_SPEED_EPS);
  });

  it('space: every class stops a 120 u/s ship in < 20 s (worst-case nose)', () => {
    for (const cls of ['scout', 'freighter', 'interceptor'] as const) {
      const start: ShipState = {
        pos: { x: 0, y: 0, z: 0 },
        vel: { x: 120, y: 0, z: 0 },
        quat: WORST_QUAT,
        regime: 'space',
      };
      const { state, ticks } = runStop(
        start,
        cls,
        400,
        { regime: 'space' },
        (s) => vecLength(s.vel) < STOP_SPEED_EPS,
      );
      expect(ticks, `${cls} stopped at ${ticks / 20} s`).toBeLessThan(400); // < 20 s
      expect(vecLength(state.vel), cls).toBeLessThan(STOP_SPEED_EPS);
    }
  });

  it('atmosphere: 30 u/s at 200 m decelerates, descends, and ends GROUNDED with |vel| < 0.5 in < 30 s', () => {
    const start: ShipState = {
      pos: { x: 0, y: 200, z: 0 },
      vel: { x: 30, y: 0, z: 0 },
      quat: WORST_QUAT,
      regime: 'atmosphere',
    };
    const { inputs, state, ticks } = runStop(
      start,
      'scout',
      600,
      { regime: 'atmosphere', planet: ATMO, heightAt: () => 0 },
      (s) => s.pos.y <= 0.05 && vecLength(s.vel) < STOP_SPEED_EPS,
    );
    expectBounded(inputs);
    expect(ticks, `landed at ${ticks / 20} s`).toBeLessThan(600); // < 30 s
    expect(state.pos.y, 'grounded exactly at the terrain').toBe(0);
    expect(vecLength(state.vel)).toBeLessThan(STOP_SPEED_EPS);
    // It descended, not drifted: the ship came down from 200 m to the ground.
    expect(state.pos.y).toBeLessThan(start.pos.y - 150);
  });

  it('atmosphere descent is a CONTROLLED sink: |vel.y| stays below 20 u/s the whole way down', () => {
    const start: ShipState = {
      pos: { x: 0, y: 200, z: 0 },
      vel: { x: 30, y: 0, z: 0 },
      quat: WORST_QUAT,
      regime: 'atmosphere',
    };
    let s = start;
    let maxVy = 0;
    for (let i = 0; i < 600 && s.pos.y > 0.05; i++) {
      s = integrateShip(
        s,
        stopInput(s, shipStats('scout'), DT, { regime: 'atmosphere', heightAt: () => 0 }),
        DT,
        'atmosphere',
        ATMO,
        'scout',
      );
      maxVy = Math.max(maxVy, Math.abs(s.vel.y));
    }
    expect(maxVy).toBeLessThan(20);
  });

  it('space at rest: stopInput returns the zero-demand (byte-identical idle) input', () => {
    const rest: ShipState = {
      pos: { x: 5, y: 6, z: 7 },
      vel: { x: 0, y: 0, z: 0 },
      quat: quatIdentity(),
      regime: 'space',
    };
    expect(stopInput(rest, shipStats('scout'), DT, { regime: 'space' })).toEqual({
      thrust: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      up: 0,
    });
  });

  it('grounded at rest (surface): also the zero-demand input; a slow airborne ship gets the descent lift', () => {
    const grounded: ShipState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0.2, y: 0, z: 0.1 },
      quat: quatIdentity(),
      regime: 'surface',
    };
    expect(stopInput(grounded, shipStats('scout'), DT, { regime: 'surface', heightAt: () => 0 })).toEqual({
      thrust: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      up: 0,
    });
    // Falling FASTER than the sink target → the controller applies lift to
    // slow the sink; hovering at rest → lift 0 (it must accelerate downward
    // to reach the ~10 u/s sink — a 2 u/s sink would not meet the 30 s AC).
    const airborne: ShipState = {
      pos: { x: 0, y: 50, z: 0 },
      vel: { x: 0, y: -6, z: 0 },
      quat: quatIdentity(),
      regime: 'atmosphere',
    };
    const out = stopInput(airborne, shipStats('scout'), DT, { regime: 'atmosphere', heightAt: () => 0 });
    expect(out.up, 'an over-speed descent gets VTOL lift, not full thrust').toBeGreaterThan(0);
    expect(out.thrust).toBe(0);
  });

  it('is deterministic: two identical runs are deep-equal (states and demands)', () => {
    const make = (): ShipState => ({
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 120, y: 0, z: 0 },
      quat: WORST_QUAT,
      regime: 'space',
    });
    const a = runStop(make(), 'scout', 300, { regime: 'space' });
    const b = runStop(make(), 'scout', 300, { regime: 'space' });
    expect(b.state).toEqual(a.state);
    expect(b.inputs).toEqual(a.inputs);
    expect(b.ticks).toBe(a.ticks);
  });

  it('does not mutate its state argument', () => {
    const start: ShipState = {
      pos: { x: 1, y: 2, z: 3 },
      vel: { x: 40, y: 5, z: -12 },
      quat: quatFromEuler(0.4, -0.2, 0.1),
      regime: 'atmosphere',
    };
    const snapshot = JSON.stringify(start);
    stopInput(start, shipStats('scout'), DT, { regime: 'atmosphere', heightAt: () => 0 });
    expect(JSON.stringify(start)).toBe(snapshot);
  });
});
