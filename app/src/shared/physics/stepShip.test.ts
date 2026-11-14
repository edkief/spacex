import { describe, expect, it } from 'vitest';
import type { Body } from '@shared/physics/bodies.ts';
import { frameSwitchAltitude } from '@shared/physics/bodies.ts';
import { DOCK_MAX_SPEED, DOCK_RANGE_M, UNDOCK_SPEED } from '@shared/physics/flightConstants.ts';
import type { FlightWorld, ShipState } from '@shared/physics/flightTypes.ts';
import { surfaceToSystem, systemToSurface } from '@shared/physics/frames.ts';
import { stepShip } from '@shared/physics/stepShip.ts';
import { IDLE, body, flatSurface, restingShip } from '@shared/physics/testkit.ts';
import {
  add,
  distance,
  fromToQuat,
  length,
  rotateVector,
  scale,
  sub,
  type Vec3,
} from '@shared/physics/vec.ts';
import { shipStats } from '@shared/ships/catalog.ts';
import { Rng } from '@shared/random.ts';

const scout = shipStats('scout');
const TOP = body.atmosphere!.top;
const SWITCH = frameSwitchAltitude(body);
const world: FlightWorld = {
  bodies: [body],
  surface: () => flatSurface(100, [{ id: 'surface-pad', x: 0, z: 0 }]),
};
const above = (alt: number): Vec3 => add(body.center, { x: 0, y: body.radius + alt, z: 0 });

describe('frame switching and regimes through the real step', () => {
  it('flies space -> atmosphere -> surface -> atmosphere -> space with the exact frame/regime sequence', () => {
    const rng = new Rng(21n);
    let s: ShipState = restingShip(above(SWITCH + 3000), { vel: { x: 0, y: -80, z: 0 } });
    const seen: string[] = [];
    const note = () => {
      const label = `${s.frame === 'system' ? 'system' : 'planet'}/${s.regime}`;
      if (seen[seen.length - 1] !== label) seen.push(label);
    };
    note();
    const altitude = () =>
      s.frame === 'system' ? length(sub(s.pos, body.center)) - body.radius : s.pos.y;

    // Descend: full "down" in the atmosphere, then idle assist for the last metres.
    for (let i = 0; i < 40_000 && s.regime !== 'surface'; i++) {
      const input = { ...IDLE, up: altitude() > 400 ? -1 : 0 };
      s = stepShip(s, input, 0.05, world, scout);
      note();
    }
    expect(s.regime).toBe('surface');
    for (let i = 0; i < 60; i++) s = stepShip(s, IDLE, 0.05, world, scout); // settle on the pad
    expect(s.regime).toBe('surface');
    expect(s.onPad).toBe('surface-pad');

    // Lift off and climb out, with a little position noise to prove there is no flapping.
    for (let i = 0; i < 40_000 && s.frame !== 'system'; i++) {
      s = stepShip(s, { ...IDLE, up: 1 }, 0.05, world, scout);
      s = { ...s, pos: { x: s.pos.x + rng.nextRange(-0.02, 0.02), y: s.pos.y, z: s.pos.z } };
      note();
    }
    expect(s.frame).toBe('system');
    expect(seen).toEqual([
      'system/space',
      'planet/space',
      'planet/atmosphere',
      'planet/surface',
      'planet/atmosphere',
      'planet/space',
      'system/space',
    ]);
  });

  it('switches frames at max(atmosphere top + 1 km, 3 km) and leaves above 1.1x that', () => {
    expect(SWITCH).toBeCloseTo(TOP + 1000, 6);
    const still = (alt: number) => stepShip(restingShip(above(alt)), IDLE, 0.05, world, scout);
    expect(still(SWITCH + 5).frame).toBe('system');
    expect(still(SWITCH - 5).frame).toBe(body.id);
    const inFrame = (y: number) =>
      restingShip({ x: 0, y, z: 0 }, { frame: body.id, regime: 'space' });
    expect(stepShip(inFrame(SWITCH * 1.1 - 5), IDLE, 0.05, world, scout).frame).toBe(body.id);
    expect(stepShip(inFrame(SWITCH * 1.1 + 5), IDLE, 0.05, world, scout).frame).toBe('system');
  });

  it('is continuous at the switch: position, speed and orientation barely change', () => {
    const vel = { x: 30, y: -40, z: 25 };
    const quat = fromToQuat({ x: 0, y: 0, z: -1 }, { x: 0.3, y: -0.9, z: 0.1 });
    const before = restingShip(above(SWITCH + 1), { vel, quat });
    const after = stepShip(before, IDLE, 0.05, world, scout);
    expect(after.frame).toBe(body.id);
    expect(length(after.vel)).toBeCloseTo(length(vel), 3);
    const sysPos = surfaceToSystem(body, after.pos);
    expect(distance(sysPos, add(before.pos, scale(vel, 0.05)))).toBeLessThan(0.01);
    const noseBefore = rotateVector(quat, { x: 0, y: 0, z: -1 });
    const noseAfter = rotateVector(after.quat, { x: 0, y: 0, z: -1 });
    expect(Math.abs(length(noseAfter) - 1)).toBeLessThan(1e-9);
    expect(noseAfter.y).toBeCloseTo(noseBefore.y, 2); // north pole: flat up == system up
  });

  it('never enters a surface frame for solid bodies or in the south polar cap', () => {
    const solid: Body = { ...body, hasSurfaceFrame: false };
    const w: FlightWorld = { bodies: [solid], surface: () => undefined };
    expect(stepShip(restingShip(above(200)), IDLE, 0.05, w, scout).frame).toBe('system');
    const south = add(body.center, { x: 0, y: -(body.radius + 2000), z: 0 });
    expect(stepShip(restingShip(south), IDLE, 0.05, world, scout).frame).toBe('system');
    expect(systemToSurface(body, above(100)).y).toBeCloseTo(100, 6);
  });

  it('descends toward the south pole and is held by the shell, never reaching the surface', () => {
    const southBody = body;
    let s = restingShip(add(southBody.center, { x: 0, y: -(southBody.radius + 20_000), z: 0 }), {
      vel: { x: 0, y: 150, z: 0 },
    });
    for (let i = 0; i < 4000; i++) s = stepShip(s, IDLE, 0.05, world, scout);
    expect(s.frame).toBe('system');
    expect(distance(s.pos, southBody.center)).toBeGreaterThanOrEqual(southBody.radius + 400 - 1e-6);
  });
});

describe('orbital docking', () => {
  const dock = {
    id: 'dock-1',
    padId: 'pad-1',
    position: add(body.center, { x: 1.6 * body.radius, y: 0, z: 0 }),
  };
  const dockWorld: FlightWorld = { bodies: [{ ...body, docks: [dock] }], surface: () => undefined };
  const near = (offset: number, vel: Vec3 = { x: 0, y: 0, z: 0 }): ShipState =>
    restingShip(add(dock.position, { x: offset, y: 0, z: 0 }), { vel });
  const dockIt = (s: ShipState) => stepShip(s, { ...IDLE, action: 'dock' }, 0.05, dockWorld, scout);

  it('docks within 100 m and below 10 m/s: snapped, stopped, up along the outward normal', () => {
    const docked = dockIt(near(DOCK_RANGE_M - 1, { x: 0, y: DOCK_MAX_SPEED - 0.5, z: 0 }));
    expect(docked.dockedAt).toBe('dock-1');
    expect(docked.pos).toEqual(dock.position);
    expect(docked.vel).toEqual({ x: 0, y: 0, z: 0 });
    const up = rotateVector(docked.quat, { x: 0, y: 1, z: 0 });
    expect(up.x).toBeCloseTo(1, 9); // the dock sits on +x of the planet, so outward is +x
  });

  it('refuses when too far, too fast, or without the dock action; holds a docked ship in place', () => {
    expect(dockIt(near(DOCK_RANGE_M + 1)).dockedAt).toBeUndefined();
    expect(dockIt(near(10, { x: DOCK_MAX_SPEED + 1, y: 0, z: 0 })).dockedAt).toBeUndefined();
    expect(stepShip(near(10), IDLE, 0.05, dockWorld, scout).dockedAt).toBeUndefined();
    let s = dockIt(near(10));
    for (let i = 0; i < 100; i++)
      s = stepShip(s, { ...IDLE, thrust: 1, yaw: 1 }, 0.05, dockWorld, scout);
    expect(s.pos).toEqual(dock.position);
    expect(s.dockedAt).toBe('dock-1');
  });

  it('undock releases the ship with a 5 m/s push away from the planet', () => {
    const docked = dockIt(near(5));
    const released = stepShip(docked, { ...IDLE, action: 'undock' }, 0.05, dockWorld, scout);
    expect(released.dockedAt).toBeUndefined();
    expect(released.vel.x).toBeGreaterThan(UNDOCK_SPEED - 0.5);
    expect(released.pos.x).toBeGreaterThan(dock.position.x);
    expect(
      stepShip(near(5), { ...IDLE, action: 'undock' }, 0.05, dockWorld, scout).dockedAt,
    ).toBeUndefined();
  });

  it('cannot dock from inside a surface frame', () => {
    const inFrame = restingShip({ x: 0, y: 500, z: 0 }, { frame: body.id, regime: 'atmosphere' });
    const w: FlightWorld = { bodies: [{ ...body, docks: [dock] }], surface: () => flatSurface(0) };
    expect(stepShip(inFrame, { ...IDLE, action: 'dock' }, 0.05, w, scout).dockedAt).toBeUndefined();
  });
});
