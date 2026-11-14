import { describe, expect, it } from 'vitest';
import { integrateShip } from '@shared/physics/flight.ts';
import {
  SURFACE_GRAVITY,
  VTOL_ACCEL_FRACTION,
  VTOL_CLIMB_RATE,
  VTOL_DESCENT_RATE,
  VTOL_IDLE_SINK_RATE,
} from '@shared/physics/flightConstants.ts';
import type { FlightContext, ShipState, SurfaceProvider } from '@shared/physics/flightTypes.ts';
import { maxFlatRadius } from '@shared/physics/frames.ts';
import { desiredVerticalSpeed, vtolAuthority } from '@shared/physics/surfaceFlight.ts';
import { IDLE, body, flatSurface, restingShip } from '@shared/physics/testkit.ts';
import { shipStats } from '@shared/ships/catalog.ts';
import { SHIP_CLASS_IDS, type ShipClassId } from '@shared/ships/ids.ts';

const TOP = body.atmosphere!.top;
const ship = (y: number, over: Partial<ShipState> = {}): ShipState =>
  restingShip({ x: 0, y, z: 0 }, { frame: body.id, regime: 'atmosphere', ...over });
const ctx = (
  id: ShipClassId = 'scout',
  surface: SurfaceProvider = flatSurface(0),
  over: Partial<FlightContext> = {},
): FlightContext => ({
  shipClass: shipStats(id),
  bodies: [body],
  surface,
  ...over,
});
const run = (state: ShipState, input: object, seconds: number, c: FlightContext, dt = 0.05) => {
  let s = state;
  for (let i = 0; i < Math.round(seconds / dt); i++)
    s = integrateShip(s, { ...IDLE, ...input }, dt, c);
  return s;
};

describe('gravity must be survivable (hover assist)', () => {
  it('an idle ship in atmosphere settles to a slow 3 m/s descent instead of plummeting', () => {
    let s = ship(3000, { vel: { x: 0, y: -50, z: 0 } }); // already falling hard
    for (let i = 0; i < 200; i++) s = integrateShip(s, IDLE, 0.05, ctx());
    expect(s.vel.y).toBeCloseTo(-VTOL_IDLE_SINK_RATE, 1);
    expect(s.pos.y).toBeLessThan(3000);
  });

  it('touches down gently: an idle ship from 300 m lands at no more than 3.5 m/s', () => {
    let s = ship(300);
    let worst = 0;
    for (let i = 0; i < 3000 && s.pos.y > 0; i++) {
      s = integrateShip(s, IDLE, 0.05, ctx());
      worst = Math.max(worst, -s.vel.y);
    }
    expect(s.pos.y).toBe(0);
    expect(worst).toBeLessThan(3.5);
  });

  it.each(SHIP_CLASS_IDS)(
    '%s: thrust-to-weight allows vertical take-off and a controlled hover',
    (id) => {
      const cls = shipStats(id);
      expect(cls.acceleration * VTOL_ACCEL_FRACTION).toBeGreaterThan(1.5 * SURFACE_GRAVITY);
      const lifted = run(ship(0), { up: 1 }, 5, ctx(id));
      expect(lifted.pos.y).toBeGreaterThan(60);
      expect(Math.abs(lifted.vel.y - VTOL_CLIMB_RATE)).toBeLessThan(1.5); // drag leaves a small hold error
    },
  );

  it('holds altitude when the commanded vertical speed is zero (hover convergence)', () => {
    const hoverUp = VTOL_IDLE_SINK_RATE / (VTOL_CLIMB_RATE + VTOL_IDLE_SINK_RATE);
    expect(desiredVerticalSpeed(hoverUp)).toBeCloseTo(0, 12);
    const s = run(ship(200, { vel: { x: 0, y: -15, z: 0 } }), { up: hoverUp }, 20, ctx());
    expect(s.pos.y).toBeGreaterThan(150);
    expect(Math.abs(s.vel.y)).toBeLessThan(0.05);
    const later = run(s, { up: hoverUp }, 10, ctx());
    expect(Math.abs(later.pos.y - s.pos.y)).toBeLessThan(0.5);
  });

  it('descends at 25 m/s on full down input and fades out above 60 m/s horizontal speed', () => {
    const down = run(ship(2000), { up: -1 }, 6, ctx());
    expect(Math.abs(down.vel.y + VTOL_DESCENT_RATE)).toBeLessThan(1.5);
    expect(vtolAuthority(0)).toBe(1);
    expect(vtolAuthority(20)).toBe(1);
    expect(vtolAuthority(40)).toBeCloseTo(0.5, 12);
    expect(vtolAuthority(60)).toBe(0);
    expect(vtolAuthority(500)).toBe(0);
  });

  it('can be disabled for pure-physics tests', () => {
    const s = run(ship(3000), {}, 2, ctx('scout', flatSurface(0), { assist: false }));
    expect(s.vel.y).toBeLessThan(-10);
  });
});

describe('ground collision (injected heightAt)', () => {
  it('stops a falling ship at the terrain height with zero vertical velocity', () => {
    const c = ctx('scout', flatSurface(120), { assist: false });
    const s = run(ship(400, { vel: { x: 0, y: -200, z: 0 } }), {}, 10, c);
    expect(s.pos.y).toBe(120);
    expect(s.vel.y).toBe(0);
  });

  it('follows sloped terrain and never ends a step below it', () => {
    const slope: SurfaceProvider = { heightAt: (x) => 0.2 * x, pads: [] };
    let s = ship(10, { vel: { x: 40, y: 0, z: 0 } });
    for (let i = 0; i < 400; i++) {
      s = integrateShip(s, { ...IDLE, thrust: 0 }, 0.05, ctx('scout', slope));
      expect(s.pos.y).toBeGreaterThanOrEqual(slope.heightAt(s.pos.x, s.pos.z) - 1e-9);
    }
  });

  it('does not tunnel through a thin ridge at high speed (substepping, steps of at most 2 m)', () => {
    const ridge: SurfaceProvider = { heightAt: (x) => (x >= 400 && x <= 402 ? 100 : 0), pads: [] };
    let s = ship(20, { vel: { x: 600, y: 0, z: 0 } });
    let highest = 0;
    for (let i = 0; i < 60; i++) {
      s = integrateShip(s, IDLE, 0.05, ctx('scout', ridge, { assist: false, gravity: 0 }));
      highest = Math.max(highest, s.pos.y);
      expect(s.pos.y).toBeGreaterThanOrEqual(ridge.heightAt(s.pos.x, s.pos.z));
    }
    expect(highest).toBeGreaterThanOrEqual(100); // it was lifted over the ridge, not skipped past it
    expect(s.pos.x).toBeGreaterThan(402);
  });

  it('applies ground friction so a landed ship comes to rest', () => {
    const s = run(ship(0, { vel: { x: 20, y: 0, z: 0 } }), {}, 3, ctx());
    expect(s.vel.x).toBe(0);
  });
});

describe('landing pads', () => {
  const pad = { id: 'pad-1', x: 10, z: 0 };
  const c = () => ctx('scout', flatSurface(0, [pad]));
  const land = (pos: { x: number; z: number }, vel = { x: 0, y: 0, z: 0 }) =>
    integrateShip(
      restingShip({ ...pos, y: 0 }, { frame: body.id, regime: 'surface', vel }),
      IDLE,
      0.05,
      c(),
    );

  it('sets onPad when on the ground within the pad radius, slowly', () => {
    expect(land({ x: 12, z: 3 }).onPad).toBe('pad-1');
    expect(land({ x: 10, z: 0 }, { x: 0, y: -1.5, z: 0 }).onPad).toBe('pad-1');
  });

  it('does not set onPad outside the radius, when too fast, or when airborne', () => {
    expect(land({ x: 40, z: 0 }).onPad).toBeUndefined();
    expect(land({ x: 10, z: 0 }, { x: 8, y: 0, z: 0 }).onPad).toBeUndefined();
    const airborne = integrateShip(ship(50, { pos: { x: 10, y: 50, z: 0 } }), IDLE, 0.05, c());
    expect(airborne.onPad).toBeUndefined();
  });

  it('clears onPad when the ship lifts off', () => {
    const landed = run(
      restingShip({ x: 10, y: 0, z: 0 }, { frame: body.id, regime: 'surface' }),
      {},
      1,
      c(),
    );
    expect(landed.onPad).toBe('pad-1');
    const lifted = run(landed, { up: 1 }, 2, c());
    expect(lifted.onPad).toBeUndefined();
  });
});

describe('surface frame limits', () => {
  it('treats the end of the usable projection (0.97 pi) as a wall', () => {
    const edge = maxFlatRadius(body);
    let s = ship(100, { pos: { x: edge - 5, y: 100, z: 0 }, vel: { x: 200, y: 0, z: 0 } });
    for (let i = 0; i < 100; i++) s = integrateShip(s, IDLE, 0.05, ctx());
    expect(s.pos.x).toBeLessThanOrEqual(edge + 1e-6);
    expect(s.vel.x).toBeLessThanOrEqual(1e-6);
  });

  it('requires a surface context for a surface frame', () => {
    expect(() =>
      integrateShip(ship(10), IDLE, 0.05, { shipClass: shipStats('scout'), bodies: [body] }),
    ).toThrow(RangeError);
  });

  it('is deterministic over a long descent', () => {
    const a = run(
      ship(500, { vel: { x: 30, y: -10, z: 5 } }),
      { thrust: 0.2, yaw: 0.1 },
      60,
      ctx(),
    );
    const b = run(
      structuredClone(ship(500, { vel: { x: 30, y: -10, z: 5 } })),
      { thrust: 0.2, yaw: 0.1 },
      60,
      ctx(),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(TOP).toBeGreaterThan(500);
  });
});
