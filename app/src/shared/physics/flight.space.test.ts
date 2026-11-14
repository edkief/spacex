import { describe, expect, it } from 'vitest';
import type { Body } from '@shared/physics/bodies.ts';
import { integrateShip } from '@shared/physics/flight.ts';
import { SOFT_CAP_DECAY_PER_S } from '@shared/physics/flightConstants.ts';
import type { FlightContext, ShipState } from '@shared/physics/flightTypes.ts';
import { FORWARD, UP } from '@shared/physics/rotation.ts';
import { IDLE, body, restingShip } from '@shared/physics/testkit.ts';
import { distance, length, rotateVector, sub, type Vec3 } from '@shared/physics/vec.ts';
import { shipStats } from '@shared/ships/catalog.ts';
import { SHIP_CLASS_IDS } from '@shared/ships/ids.ts';

const FAR: Vec3 = { x: 0, y: 0, z: 0 };
// A planet a billion metres away: the ship below is in open space (travel factor at its maximum).
const distant: Body = { ...body, center: { x: 1e9, y: 0, z: 0 } };
const scout = shipStats('scout');
const ctx = (cls = scout, bodies: readonly Body[] = [distant]): FlightContext => ({
  shipClass: cls,
  bodies,
});
const run = (
  state: ShipState,
  input: Partial<typeof IDLE> & Record<string, unknown>,
  seconds: number,
  c = ctx(),
  dt = 0.05,
) => {
  let s = state;
  for (let i = 0; i < Math.round(seconds / dt); i++)
    s = integrateShip(s, { ...IDLE, ...input }, dt, c);
  return s;
};
const angle = (q: { w: number }) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));

describe('space flight (system frame)', () => {
  it('moves in a straight line at constant velocity with no input (no drag, no damping)', () => {
    const start = restingShip(FAR, { vel: { x: 10, y: -4, z: 2 } });
    const end = run(start, {}, 20);
    expect(end.vel).toEqual({ x: 10, y: -4, z: 2 });
    expect(distance(end.pos, { x: 200, y: -80, z: 40 })).toBeLessThan(1e-9);
  });

  it('accelerates along the nose at class acceleration times the travel factor', () => {
    const factor = 4000; // far from everything
    const end = run(restingShip(FAR), { thrust: 1 }, 1);
    expect(-end.vel.z).toBeCloseTo(scout.acceleration * factor, 0); // nose is -z
    expect(Math.abs(end.vel.x) + Math.abs(end.vel.y)).toBeLessThan(1e-9);
  });

  it('reverses with negative thrust and thrusts along ship-up in space with `up`', () => {
    expect(run(restingShip(FAR), { thrust: -1 }, 0.5).vel.z).toBeGreaterThan(0);
    expect(run(restingShip(FAR), { up: 1 }, 0.5).vel.y).toBeGreaterThan(0);
    const diagonal = run(restingShip(FAR), { thrust: 1, up: 1 }, 1);
    expect(length(diagonal.vel)).toBeCloseTo(scout.acceleration * 4000, 0); // command capped at 1
  });

  it.each(SHIP_CLASS_IDS)('%s: cruises at maxVelocity x travel factor, then holds there', (id) => {
    const cls = shipStats(id);
    const end = run(restingShip(FAR), { thrust: 1 }, 15, ctx(cls));
    const cap = cls.maxVelocity * 4000;
    expect(length(end.vel)).toBeGreaterThan(cap * 0.99);
    expect(length(end.vel)).toBeLessThan(cap * 1.08); // soft cap: a few percent over at full throttle
  });

  it('decays speed above the cap softly and independently of the step size', () => {
    const near = { ...body, center: { x: 0, y: -body.radius, z: 0 } }; // surface touching the ship: factor 1
    const fast = restingShip(
      { x: 0, y: 2000, z: 0 },
      { vel: { x: 0, y: 0, z: -5 * scout.maxVelocity * 3 } },
    );
    const c = ctx(scout, [near]);
    const many = run(fast, {}, 1, c, 0.05);
    const one = run(fast, {}, 1, c, 1);
    const cap = scout.maxVelocity * (1 + 2000 / 1000);
    const excess = 5 * scout.maxVelocity * 3 - cap;
    expect(length(one.vel) - cap).toBeCloseTo(excess * Math.exp(-SOFT_CAP_DECAY_PER_S), 6);
    expect(Math.abs(length(many.vel) - length(one.vel)) / length(one.vel)).toBeLessThan(0.01);
    expect(length(run(fast, {}, 0.05, c).vel)).toBeLessThan(length(fast.vel));
  });

  it('brakes to a stop without overshooting or reversing', () => {
    const moving = restingShip(FAR, { vel: { x: 0, y: 0, z: -500_000 } });
    let s = moving;
    let t = 0;
    while (length(s.vel) > 0 && t < 10) {
      s = integrateShip(s, { ...IDLE, brake: true }, 0.05, ctx());
      t += 0.05;
      expect(s.vel.z).toBeLessThanOrEqual(0);
    }
    expect(length(s.vel)).toBe(0);
    expect(t).toBeCloseTo(500_000 / (scout.acceleration * 4000), 0);
  });

  describe('rotation', () => {
    it('turns at the class turn rate about each axis (+yaw left, +pitch up, +roll right)', () => {
      const yawed = run(restingShip(FAR), { yaw: 1 }, 1);
      expect(angle(yawed.quat)).toBeCloseTo(scout.turnRate, 3);
      const nose = rotateVector(yawed.quat, FORWARD);
      expect(nose.x).toBeLessThan(0); // facing -z, yaw left turns toward -x
      expect(
        rotateVector(run(restingShip(FAR), { pitch: 1 }, 0.5).quat, FORWARD).y,
      ).toBeGreaterThan(0);
      const rolled = rotateVector(run(restingShip(FAR), { roll: 1 }, 0.5).quat, UP);
      expect(rolled.x).toBeGreaterThan(0.1);
      expect(rolled.x).toBeCloseTo(Math.sin(scout.turnRate * 0.5), 2);
    });

    it('caps the combined demand at the turn rate, per class', () => {
      for (const id of SHIP_CLASS_IDS) {
        const cls = shipStats(id);
        const s = run(restingShip(FAR), { yaw: 1, pitch: 1, roll: 1 }, 0.5, ctx(cls));
        expect(angle(s.quat)).toBeCloseTo(cls.turnRate * 0.5, 2);
      }
      expect(angle(run(restingShip(FAR), { yaw: 0.5 }, 1).quat)).toBeCloseTo(
        scout.turnRate * 0.5,
        3,
      );
    });

    it('keeps the orientation a unit quaternion over a long manoeuvre', () => {
      const s = run(restingShip(FAR), { yaw: 0.7, pitch: -0.4, roll: 0.9 }, 60);
      const { x, y, z, w } = s.quat;
      expect(Math.sqrt(x * x + y * y + z * z + w * w)).toBeCloseTo(1, 12);
    });

    it('thrust follows the nose after turning', () => {
      const turned = run(restingShip(FAR), { yaw: 1 }, 1);
      const moving = integrateShip(turned, { ...IDLE, thrust: 1 }, 0.5, ctx());
      expect(moving.vel.x).toBeLessThan(0);
      expect(Math.abs(moving.vel.x / moving.vel.z)).toBeGreaterThan(0.5);
    });
  });

  describe('solid bodies', () => {
    const lethal = (b: Body, speed: number, dt: number) => {
      const start = { x: b.center.x + b.radius + 5_000_000, y: b.center.y, z: b.center.z };
      let s = restingShip(start, { vel: { x: -speed, y: 0, z: 0 } });
      let closest = Infinity;
      for (let i = 0; i < 200; i++) {
        s = integrateShip(s, IDLE, dt, { shipClass: scout, bodies: [b] });
        closest = Math.min(closest, distance(s.pos, b.center) - b.radius);
      }
      return { s, closest };
    };

    it('never lets a ship pass inside a planet, gas giant or star, even at absurd speeds', () => {
      const solid = (radius: number, over: Partial<Body> = {}): Body => ({
        ...body,
        center: { x: 0, y: 0, z: 0 },
        radius,
        hasSurfaceFrame: false,
        ...over,
      });
      for (const b of [
        solid(80_000),
        solid(600_000),
        solid(5_000_000, { id: 'star', kind: 'star' }),
      ]) {
        for (const speed of [300, 1.2e6, 2e7, 1e9]) {
          const { s, closest } = lethal(b, speed, 0.05);
          expect(closest, `${b.radius} @ ${speed}`).toBeGreaterThanOrEqual(-1e-6);
          expect(distance(s.pos, b.center)).toBeGreaterThanOrEqual(b.radius);
        }
      }
    });

    it('removes the inward velocity on contact and keeps the tangential motion', () => {
      const b = { ...body, center: { x: 0, y: 0, z: 0 }, radius: 100_000, hasSurfaceFrame: false };
      let s = restingShip({ x: b.radius + 1000, y: 0, z: 0 }, { vel: { x: -250, y: 0, z: 70 } });
      for (let i = 0; i < 100; i++)
        s = integrateShip(s, IDLE, 0.05, { shipClass: scout, bodies: [b] });
      // The 250 m/s approach (below the speed cap) is gone; what remains is the ~70 m/s sliding along the surface.
      expect(length(s.vel)).toBeGreaterThan(65);
      expect(length(s.vel)).toBeLessThan(75);
      expect(distance(s.pos, b.center)).toBeGreaterThanOrEqual(b.radius);
    });

    it('pushes a ship that starts inside a body back out', () => {
      const b = { ...body, center: { x: 0, y: 0, z: 0 }, hasSurfaceFrame: false };
      const s = integrateShip(restingShip({ x: 1000, y: 0, z: 0 }), IDLE, 0.05, {
        shipClass: scout,
        bodies: [b],
      });
      expect(distance(s.pos, b.center)).toBeGreaterThanOrEqual(b.radius);
    });

    it('closes the south polar cap of a landable planet with a shell at the maximum terrain height', () => {
      const planet = { ...body, center: { x: 0, y: 0, z: 0 } };
      const start = restingShip(
        { x: 0, y: -(planet.radius + 3000), z: 0 },
        { vel: { x: 0, y: 200, z: 0 } },
      );
      let s = start;
      for (let i = 0; i < 200; i++)
        s = integrateShip(s, IDLE, 0.05, { shipClass: scout, bodies: [planet] });
      expect(length(sub(s.pos, planet.center))).toBeGreaterThanOrEqual(planet.radius + 400);
    });
  });

  it('holds a docked ship in place', () => {
    const docked = restingShip({ x: 5, y: 6, z: 7 }, { dockedAt: 'dock' });
    expect(integrateShip(docked, { ...IDLE, thrust: 1, yaw: 1 }, 0.05, ctx())).toEqual(docked);
  });

  it('is deterministic: identical inputs give identical states, however the objects are built', () => {
    const input = { ...IDLE, thrust: 0.7, yaw: 0.3, pitch: -0.2, roll: 0.1 };
    const a = run(restingShip({ x: 1, y: 2, z: 3 }), input, 30);
    const b = run(structuredClone(restingShip({ x: 1, y: 2, z: 3 })), structuredClone(input), 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('throws for an unknown regime and for invalid time steps', () => {
    expect(() =>
      integrateShip({ ...restingShip(FAR), regime: 'orbit' as never }, IDLE, 0.05, ctx()),
    ).toThrow(RangeError);
    for (const dt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => integrateShip(restingShip(FAR), IDLE, dt, ctx())).toThrow(RangeError);
    }
  });
});
