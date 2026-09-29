import { describe, expect, it } from 'vitest';
import atmoFixture from './__fixtures__/flight-atmo-30s.json';
import spaceFixture from './__fixtures__/flight-space-60s.json';
import { ATMOSPHERE_BOUNDARY_M, atmosphereFactor } from './atmosphere';
import {
  GRAVITY,
  integrateShip,
  PAD_RADIUS,
  restShipState,
  SOFT_CAP_DECAY,
  UnknownRegimeError,
  type PlanetAtmo,
  type Regime,
  type ShipInput,
  type ShipState,
} from './flight';
import { quatRotateVector, vec, vecLength, type Quat } from './vec';
import type { ShipClassId } from '../ships';

const DT = 0.05; // server fixed tick (1/20 s)

const NO_INPUT: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };

function quatFromYaw(yaw: number): Quat {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function runSteps(
  state: ShipState,
  input: ShipInput,
  dt: number,
  steps: number,
  regime: Regime,
  planet?: PlanetAtmo,
  shipClass: string = 'scout',
  heightAt: (x: number, z: number) => number = () => 0,
  pads?: Array<{ id: string; x: number; z: number }>,
): ShipState {
  let s = state;
  for (let i = 0; i < steps; i++) {
    s = integrateShip(s, input, dt, regime, planet, shipClass as ShipClassId, {
      heightAt,
      pads,
    });
  }
  return s;
}

/** Deep component-wise comparison with tolerance. */
function expectCloseToState(actual: ShipState, expected: ShipState, eps: number): void {
  const pairs: Array<[number, number]> = [
    [actual.pos.x, expected.pos.x],
    [actual.pos.y, expected.pos.y],
    [actual.pos.z, expected.pos.z],
    [actual.vel.x, expected.vel.x],
    [actual.vel.y, expected.vel.y],
    [actual.vel.z, expected.vel.z],
    [actual.quat.x, expected.quat.x],
    [actual.quat.y, expected.quat.y],
    [actual.quat.z, expected.quat.z],
    [actual.quat.w, expected.quat.w],
  ];
  for (const [a, b] of pairs) {
    expect(Math.abs(a - b), `component ${a} vs ${b}`).toBeLessThanOrEqual(eps);
  }
  expect(actual.regime).toBe(expected.regime);
  expect(actual.onPad).toBe(expected.onPad);
}

interface Fixture {
  scenario: string;
  dt: number;
  steps: number;
  shipClass: string;
  planet: PlanetAtmo | null;
  initial: ShipState;
  input: ShipInput;
  heightAt: { kind: 'flat' | 'slope'; value: number };
  pads: Array<{ id: string; x: number; z: number }>;
  sampleEvery: number;
  samples: Array<{ t: number; state: ShipState }>;
}

function replay(f: Fixture): void {
  let s = f.initial;
  for (let i = 1; i <= f.steps; i++) {
    s = integrateShip(
      s,
      f.input,
      f.dt,
      f.initial.regime,
      f.planet ?? undefined,
      f.shipClass as ShipClassId,
      {
        heightAt: () => f.heightAt.value,
        pads: f.pads,
      },
    );
    if (i % f.sampleEvery === 0 || i === f.steps) {
      expectCloseToState(s, f.samples[((i - 1) / f.sampleEvery) | 0].state, 1e-9);
    }
  }
}

describe('atmosphere boundary (shared with TASK-28)', () => {
  it('ramps 0→k across the 1 km band, 0 below, 1 above', () => {
    expect(atmosphereFactor(-100)).toBe(0);
    expect(atmosphereFactor(0)).toBe(0);
    expect(atmosphereFactor(ATMOSPHERE_BOUNDARY_M / 2)).toBe(0.5);
    expect(atmosphereFactor(ATMOSPHERE_BOUNDARY_M - 0.001)).toBeCloseTo(1, 5);
    expect(atmosphereFactor(ATMOSPHERE_BOUNDARY_M)).toBe(1);
    expect(atmosphereFactor(ATMOSPHERE_BOUNDARY_M + 500)).toBe(1);
    expect(ATMOSPHERE_BOUNDARY_M).toBe(1000);
  });

  it('crossing the boundary under constant input changes drag continuously (no kick)', () => {
    // fall from 1200 u through the 1000 u boundary, sampling every 10 ms
    const planet: PlanetAtmo = { atmosphereDensity: 0.1 };
    const kFull = (planet.atmosphereDensity * 2 * Math.sqrt(20)) / 20; // scout, factor 1
    const dtStep = 0.01;
    let s = restShipState({ x: 0, y: 1200, z: 0 }, 'atmosphere');
    let maxDelta = 0;
    let prevY = s.vel.y;
    let prevAlt = 1200;
    for (let i = 0; i < 3000; i++) {
      const prevSpeed = Math.abs(prevY);
      s = integrateShip(s, NO_INPUT, dtStep, 'atmosphere', planet, 'scout');
      const delta = Math.abs(s.vel.y - prevY);
      if (prevAlt < ATMOSPHERE_BOUNDARY_M && s.pos.y >= ATMOSPHERE_BOUNDARY_M) {
        // the exact step that crosses: the change may only be the smooth
        // gravity + full-factor drag evolution. A step change of coefficient
        // (the old 0→k behavior) would add an extra ~k·v²·dt kick on top.
        expect(delta).toBeLessThanOrEqual(
          (GRAVITY + kFull * prevSpeed * prevSpeed) * dtStep + 1e-6,
        );
      }
      maxDelta = Math.max(maxDelta, delta);
      prevY = s.vel.y;
      prevAlt = s.pos.y;
    }
    // terminal velocity in full atmosphere: every step's change is bounded by
    // the smooth (g + k·v²)·dt — no discontinuity anywhere
    expect(maxDelta).toBeLessThanOrEqual((GRAVITY + kFull * 16 * 16) * dtStep + 1e-6);
    expect(s.pos.y).toBeGreaterThanOrEqual(0);
  });
});

describe('space regime', () => {
  it('straight-line trajectory: constant forward thrust accelerates along +Z', () => {
    const s = runSteps(
      restShipState({ x: 0, y: 0, z: 0 }, 'space'),
      { ...NO_INPUT, thrust: 1 },
      DT,
      20, // 1 s, scout acceleration = 40 u/s²
      'space',
    );
    // Forward Euler, dt = 0.05: v = a·t = 40; d = Σ vᵢ·dt = a·dt²·Σᵢ i = 21
    // (½·a·t² + ½·a·dt, the standard half-step Euler offset)
    expect(s.vel.z).toBeCloseTo(40, 9);
    expect(s.pos.z).toBeCloseTo(21, 9);
    expect(s.pos.x).toBe(0);
    expect(s.pos.y).toBe(0);
    expect(s.vel.x).toBe(0);
    expect(s.vel.y).toBe(0);
  });

  it('no input = no motion (Newton first law, zero damping)', () => {
    const s = runSteps(restShipState({ x: 1, y: 2, z: 3 }, 'space'), NO_INPUT, DT, 100, 'space');
    expect(s.pos).toEqual(vec(1, 2, 3));
    expect(s.vel).toEqual(vec(0, 0, 0));
  });

  it('rotation is capped by class turnRate and turns the ship', () => {
    const s = integrateShip(
      restShipState({ x: 0, y: 0, z: 0 }, 'space'),
      { ...NO_INPUT, yaw: 1 },
      DT,
      'space',
      undefined,
      'scout', // turnRate 0.8 rad/s → 0.04 rad this tick
    );
    const forward = quatRotateVector(s.quat, vec(0, 0, 1));
    const angle = Math.acos(Math.max(-1, Math.min(1, forward.z)));
    expect(angle).toBeCloseTo(0.8 * DT, 9);
  });

  it('soft speed cap: excess above maxVelocity decays 0.95 per step', () => {
    const state: ShipState = {
      pos: vec(0, 0, 0),
      vel: vec(0, 0, 130),
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    };
    const s = integrateShip(state, NO_INPUT, DT, 'space', undefined, 'scout'); // maxVel 120
    // 130 → 120 + 10·0.95
    expect(vecLength(s.vel)).toBeCloseTo(120 + 10 * SOFT_CAP_DECAY, 12);
    const s2 = integrateShip(s, NO_INPUT, DT, 'space', undefined, 'scout');
    const over = vecLength(s2.vel) - 120;
    expect(over).toBeCloseTo(10 * SOFT_CAP_DECAY * SOFT_CAP_DECAY, 12);
  });

  it('soft cap never pushes speed above maxVelocity', () => {
    const state: ShipState = {
      pos: vec(0, 0, 0),
      vel: vec(0, 0, 10000),
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    };
    const s = runSteps(state, NO_INPUT, DT, 1000, 'space');
    expect(vecLength(s.vel)).toBeLessThanOrEqual(120 + 1e-9); // float noise only
  });
});

describe('atmosphere regime', () => {
  it('terminal velocity: drag balances gravity at v = √(g/k)', () => {
    const planet: PlanetAtmo = { atmosphereDensity: 0.01 };
    // k = ρ·area/mass = 0.01 · 2√20 / 20 (scout)
    const k = (planet.atmosphereDensity * 2 * Math.sqrt(20)) / 20;
    const vTerminal = Math.sqrt(GRAVITY / k);

    // exactly at terminal velocity the net force is zero (altitude above the
    // 1 km boundary so the drag factor is full)
    const atTerminal: ShipState = {
      pos: vec(0, 2000, 0),
      vel: vec(0, -vTerminal, 0),
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    const s = integrateShip(atTerminal, NO_INPUT, DT, 'atmosphere', planet, 'scout');
    expect(s.vel.y).toBeCloseTo(-vTerminal, 9);

    // falling from rest converges onto terminal velocity
    const fallen = runSteps(
      restShipState({ x: 0, y: 50000, z: 0 }, 'atmosphere'),
      NO_INPUT,
      0.5,
      200, // 100 s
      'atmosphere',
      planet,
    );
    expect(fallen.vel.y).toBeCloseTo(-vTerminal, 1);
    expect(fallen.pos.y).toBeGreaterThan(0);
  });

  it('ground collision clamps to terrain and kills downward velocity (no tunneling)', () => {
    // 1000 u/s downward over a 0.05 s tick = 50 u travel → forces substepping
    const state: ShipState = {
      pos: vec(0, 3, 0),
      vel: vec(0, -1000, 0),
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    const s = integrateShip(state, NO_INPUT, DT, 'atmosphere', { atmosphereDensity: 0.1 }, 'scout');
    expect(s.pos.y).toBe(0); // exactly at flat ground, never below
    expect(s.vel.y).toBe(0);
    expect(s.pos.x).toBe(0);
    expect(s.pos.z).toBe(0);
  });

  it('ground collision follows sloped terrain (heightAt callback)', () => {
    const state: ShipState = {
      pos: vec(100, 50, 0),
      vel: vec(0, -3000, 0), // 150 u travel this tick → forces substepping
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    // airless (density 0) → ballistic: the ship must not tunnel past y = 20
    const s = integrateShip(state, NO_INPUT, DT, 'atmosphere', { atmosphereDensity: 0 }, 'scout', {
      heightAt: (x) => 10 + 0.1 * x, // slope: terrain at x=100 is y=20
    });
    expect(s.pos.y).toBe(20);
    expect(s.vel.y).toBe(0);

    // starting already below terrain snaps up onto it
    const below: ShipState = {
      pos: vec(100, 5, 0),
      vel: vec(0, 0, 0),
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    const s2 = integrateShip(
      below,
      NO_INPUT,
      DT,
      'atmosphere',
      { atmosphereDensity: 0.1 },
      'scout',
      {
        heightAt: (x) => 10 + 0.1 * x,
      },
    );
    expect(s2.pos.y).toBe(20);
  });

  it('VTOL hover converges: lift cancels gravity, drag damps vel.y to 0', () => {
    const planet: PlanetAtmo = { atmosphereDensity: 1 };
    // falling into the hover at full-atmosphere altitude (above the 1 km ramp)
    const s = runSteps(
      {
        pos: vec(0, 2000, 0),
        vel: vec(0, -8, 0),
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: 'atmosphere',
      },
      { ...NO_INPUT, up: 1 },
      DT,
      600, // 30 s
      'atmosphere',
      planet,
    );
    expect(Math.abs(s.vel.y)).toBeLessThan(0.1); // nearly hovering
    expect(2000 - s.pos.y).toBeLessThan(11); // bounded drop, no sustained fall
    // and it holds: near-zero drift over another 30 s
    const held = runSteps(s, { ...NO_INPUT, up: 1 }, DT, 600, 'atmosphere', planet);
    expect(Math.abs(held.vel.y)).toBeLessThan(0.1);
    expect(Math.abs(held.pos.y - s.pos.y)).toBeLessThan(3);
  });

  it('VTOL lift is heading-independent and gated by horizontal speed', () => {
    const planet: PlanetAtmo = { atmosphereDensity: 0.1 };
    const upInput: ShipInput = { ...NO_INPUT, up: 1 };

    // yawed 90°: identical vertical behaviour as facing +Z
    const facing = (quat: Quat): ShipState => ({
      pos: vec(0, 50, 0),
      vel: vec(0, -8, 0),
      quat,
      regime: 'atmosphere',
    });
    const a = runSteps(facing({ x: 0, y: 0, z: 0, w: 1 }), upInput, DT, 100, 'atmosphere', planet);
    const b = runSteps(facing(quatFromYaw(Math.PI / 2)), upInput, DT, 100, 'atmosphere', planet);
    expect(b.vel.y).toBeCloseTo(a.vel.y, 12);
    expect(b.pos.y).toBeCloseTo(a.pos.y, 12);

    // horizontal speed at/above the VTOL limit (5 u/s) disables lift
    // (no atmosphere → no drag, so the vertical change is gravity exactly)
    const fast: ShipState = {
      pos: vec(0, 50, 0),
      vel: vec(6, -2, 0),
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    const s = integrateShip(fast, upInput, DT, 'atmosphere', undefined, 'scout');
    // gravity only this tick: lift not applied
    expect(s.vel.y).toBeCloseTo(-2 - GRAVITY * DT, 9);
  });

  it('settled on a pad → onPad set; off-pad or too fast → undefined', () => {
    const planet: PlanetAtmo = { atmosphereDensity: 0.1 };
    const pads = [{ id: 'pad-0', x: 0, z: 0 }];

    const settled: ShipState = {
      pos: vec(1, 0, 0),
      vel: vec(0, 0, 0),
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    const s = integrateShip(settled, NO_INPUT, DT, 'atmosphere', planet, 'scout', {
      pads,
    });
    expect(s.onPad).toBe('pad-0');

    // outside the pad radius → no docking
    const far: ShipState = { ...settled, pos: vec(PAD_RADIUS + 1, 0, 0) };
    expect(integrateShip(far, NO_INPUT, DT, 'atmosphere', planet, 'scout', { pads }).onPad).toBe(
      undefined,
    );

    // still moving horizontally (≥ VTOL limit) across the pad → no docking
    const sliding: ShipState = {
      pos: vec(1, 0, 0),
      vel: vec(6, 0, 0),
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'atmosphere',
    };
    const slid = integrateShip(sliding, NO_INPUT, DT, 'atmosphere', planet, 'scout', { pads });
    expect(slid.pos.x).toBeCloseTo(1 + 6 * DT, 9); // still over the pad
    expect(slid.onPad).toBe(undefined); // but not settled

    // in space, a pad never sets onPad
    const inSpace: ShipState = { ...settled, regime: 'space' };
    expect(integrateShip(inSpace, NO_INPUT, DT, 'space', undefined, 'scout', { pads }).onPad).toBe(
      undefined,
    );
  });
});

describe('determinism', () => {
  it('same (state, input, dt) → bit-identical state', () => {
    const state: ShipState = {
      pos: vec(0.1, -2.3, 7.7),
      vel: vec(3.2, -14.1, 55.5),
      quat: { x: 0.1, y: -0.3, z: 0.5, w: 0.8 },
      regime: 'atmosphere',
    };
    const input: ShipInput = { thrust: 0.7, yaw: -0.4, pitch: 0.9, roll: 0.2, up: 1 };
    const a = integrateShip(state, input, DT, 'atmosphere', { atmosphereDensity: 0.137 }, 'scout');
    const b = integrateShip(state, input, DT, 'atmosphere', { atmosphereDensity: 0.137 }, 'scout');
    expect(a).toStrictEqual(b);
    const c = integrateShip(state, input, DT, 'space', undefined, 'scout');
    const d = integrateShip(state, input, DT, 'space', undefined, 'scout');
    expect(c).toStrictEqual(d);
    // the input is never mutated (pure function)
    expect(input).toEqual({ thrust: 0.7, yaw: -0.4, pitch: 0.9, roll: 0.2, up: 1 });
  });

  it('golden fixture: 60 s space flight replays within 1e-9', () => {
    replay(spaceFixture as unknown as Fixture);
  });

  it('golden fixture: 30 s atmosphere descent ends settled on the pad, within 1e-9', () => {
    const f = atmoFixture as unknown as Fixture;
    replay(f);
    const last = f.samples[f.samples.length - 1].state;
    expect(last.onPad).toBe('pad-0');
    expect(last.pos.y).toBeCloseTo(0, 9);
    expect(Math.abs(last.vel.y)).toBeLessThan(1e-6);
  });
});

describe('input sanitization and validation', () => {
  it('out-of-range inputs are clamped to the [-1, 1] contract', () => {
    const base = restShipState({ x: 0, y: 0, z: 0 }, 'space');
    const clamped = integrateShip(
      base,
      { ...NO_INPUT, thrust: 1 },
      DT,
      'space',
      undefined,
      'scout',
    );
    const wild = integrateShip(base, { ...NO_INPUT, thrust: 42 }, DT, 'space', undefined, 'scout');
    expect(wild).toStrictEqual(clamped);
    expect(
      integrateShip(
        base,
        { ...NO_INPUT, up: 9 },
        DT,
        'atmosphere',
        { atmosphereDensity: 0.1 },
        'scout',
      ),
    ).toStrictEqual(
      integrateShip(
        base,
        { ...NO_INPUT, up: 1 },
        DT,
        'atmosphere',
        { atmosphereDensity: 0.1 },
        'scout',
      ),
    );
  });

  it('unknown regime throws UnknownRegimeError', () => {
    const state = restShipState({ x: 0, y: 0, z: 0 }, 'space');
    expect(() =>
      integrateShip(state, NO_INPUT, DT, 'subspace' as unknown as Regime, undefined, 'scout'),
    ).toThrow(/subspace/);
    expect(() =>
      integrateShip(state, NO_INPUT, DT, 'subspace' as unknown as Regime, undefined, 'scout'),
    ).toThrow(UnknownRegimeError);
    // both real regimes work
    expect(() => integrateShip(state, NO_INPUT, DT, 'space', undefined, 'scout')).not.toThrow();
    expect(() =>
      integrateShip(state, NO_INPUT, DT, 'atmosphere', { atmosphereDensity: 0.1 }, 'scout'),
    ).not.toThrow();
  });

  it('invalid dt is rejected', () => {
    const state = restShipState({ x: 0, y: 0, z: 0 }, 'space');
    expect(() => integrateShip(state, NO_INPUT, 0, 'space', undefined, 'scout')).toThrow(/dt/);
    expect(() => integrateShip(state, NO_INPUT, -1, 'space', undefined, 'scout')).toThrow(/dt/);
    expect(() => integrateShip(state, NO_INPUT, Number.NaN, 'space', undefined, 'scout')).toThrow(
      /dt/,
    );
  });

  it('unknown ship class id throws the catalog error', () => {
    const state = restShipState({ x: 0, y: 0, z: 0 }, 'space');
    expect(() =>
      integrateShip(state, NO_INPUT, DT, 'space', undefined, 'warp' as unknown as ShipClassId),
    ).toThrow(/unknown ship class id: warp/);
  });
});
