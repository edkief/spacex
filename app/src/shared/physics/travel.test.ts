import { describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { bodiesOf, type Body } from '@shared/physics/bodies.ts';
import {
  SOFT_CAP_DECAY_PER_S,
  TRAVEL_MAX_FACTOR,
  TRAVEL_SCALE_DISTANCE_M,
} from '@shared/physics/flightConstants.ts';
import type { FlightWorld, ShipState } from '@shared/physics/flightTypes.ts';
import { stepShip } from '@shared/physics/stepShip.ts';
import { distanceToNearest, softCapSpeed, speedFactor } from '@shared/physics/travel.ts';
import { IDLE, body, flatSurface, restingShip } from '@shared/physics/testkit.ts';
import { add, distance, fromToQuat, length, scale, sub, type Vec3 } from '@shared/physics/vec.ts';
import { shipStats } from '@shared/ships/catalog.ts';
import { SHIP_CLASS_IDS } from '@shared/ships/ids.ts';

describe('travel scale f(d) = 1 + d / D', () => {
  it('uses the named constants and is capped at F_MAX', () => {
    expect([TRAVEL_SCALE_DISTANCE_M, TRAVEL_MAX_FACTOR, SOFT_CAP_DECAY_PER_S]).toEqual([
      1000, 4000, 8,
    ]);
    expect(speedFactor(0)).toBe(1);
    expect(speedFactor(-5)).toBe(1);
    expect(speedFactor(1000)).toBe(2);
    expect(speedFactor(3_999_000)).toBe(4000);
    expect(speedFactor(4_500_000)).toBe(4000);
    expect(speedFactor(1e12)).toBe(4000);
  });

  it('measures distance to the nearest surface or dock, so the cap falls near docks too', () => {
    const planet: Body = {
      ...body,
      docks: [
        { id: 'd', padId: 'p', position: add(body.center, { x: 1.6 * body.radius, y: 0, z: 0 }) },
      ],
    };
    const nearDock = add(planet.docks[0]!.position, { x: 0, y: 40, z: 0 });
    expect(distanceToNearest(nearDock, [planet])).toBeCloseTo(40, 6);
    expect(
      distanceToNearest(add(body.center, { x: 0, y: body.radius + 123, z: 0 }), [body]),
    ).toBeCloseTo(123, 6);
    expect(distanceToNearest(body.center, [body])).toBe(0);
    expect(speedFactor(distanceToNearest(nearDock, [planet]))).toBeCloseTo(1.04, 6);
  });

  it('soft cap: excess decays exponentially and never undershoots', () => {
    expect(softCapSpeed(100, 300, 1)).toBe(100);
    expect(softCapSpeed(1300, 300, 0)).toBe(1300);
    expect(softCapSpeed(1300, 300, 0.25)).toBeCloseTo(300 + 1000 * Math.exp(-8 * 0.25), 9);
    expect(softCapSpeed(1300, 300, 100)).toBeCloseTo(300, 9);
  });
});

/** Flies straight at a body at full throttle from `startAlt` metres out; returns the run's facts. */
function approach(
  target: Body,
  bodies: readonly Body[],
  startAlt: number,
  cls: ReturnType<typeof shipStats>,
  until = 2000,
) {
  const dir = { x: 0, y: 1, z: 0 };
  const start = add(target.center, scale(dir, target.radius + startAlt));
  const world: FlightWorld = { bodies, surface: () => flatSurface(0) };
  let s: ShipState = restingShip(start, {
    quat: fromToQuat({ x: 0, y: 0, z: -1 }, scale(dir, -1)),
  });
  let t = 0;
  let reachedAt = -1;
  let speedAtReach = 0;
  let closest = Infinity;
  let peak = 0;
  for (let i = 0; i < 20_000 && t < 500; i++) {
    s = stepShip(s, { ...IDLE, thrust: 1 }, 0.05, world, cls);
    t += 0.05;
    const alt = s.frame === 'system' ? distance(s.pos, target.center) - target.radius : s.pos.y;
    closest = Math.min(closest, alt);
    peak = Math.max(peak, length(s.vel));
    if (reachedAt < 0 && alt < until) {
      reachedAt = t;
      speedAtReach = length(s.vel);
    }
  }
  return { reachedAt, speedAtReach, closest, peak, final: s };
}

describe('cruising from 100,000 km out to 2 km altitude at full throttle', () => {
  const results = Object.fromEntries(
    SHIP_CLASS_IDS.map((id) => [id, approach(body, [body], 1e8, shipStats(id))]),
  );
  const table = SHIP_CLASS_IDS.map(
    (id) =>
      `${id}: ${results[id]!.reachedAt.toFixed(1)} s, ${results[id]!.speedAtReach.toFixed(0)} m/s at 2 km, peak ${(results[id]!.peak / 1000).toFixed(0)} km/s`,
  );

  it('takes about 1-4 minutes depending on class (numbers printed)', () => {
    console.log(`100,000 km -> 2 km altitude (dt 0.05 s):\n  ${table.join('\n  ')}`);
    expect(results.scout!.reachedAt).toBeGreaterThan(100);
    expect(results.scout!.reachedAt).toBeLessThan(125);
    expect(results.freighter!.reachedAt).toBeGreaterThan(200);
    expect(results.freighter!.reachedAt).toBeLessThan(235);
    expect(results.interceptor!.reachedAt).toBeGreaterThan(65);
    expect(results.interceptor!.reachedAt).toBeLessThan(85);
  });

  it('cruises at hundreds of km/s in open space and arrives at hundreds of m/s (drag-limited)', () => {
    for (const id of SHIP_CLASS_IDS) {
      const cls = shipStats(id);
      expect(results[id]!.peak).toBeGreaterThan(cls.maxVelocity * 3000);
      expect(results[id]!.speedAtReach).toBeLessThan(cls.maxVelocity * 3.1); // never above the cap at 2 km
    }
  });

  it('never gets inside the planet: the closest altitude stays at or above the surface', () => {
    for (const id of SHIP_CLASS_IDS) expect(results[id]!.closest, id).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('no tunnelling through solid bodies at max cruise with a 50 ms step', () => {
  const system = generateSystemForStar(
    'drift-dev-seed-001',
    generateStars('drift-dev-seed-001')[0]!,
  );
  const bodies = bodiesOf(system);

  it.each(
    bodies.map(
      (b) =>
        [b.kind === 'star' ? 'the star' : `planet ${b.id} (R=${b.radius / 1000} km)`, b] as const,
    ),
  )('a full-throttle dive at %s stops at its surface', (_label, target) => {
    const { closest, final } = approach(target, bodies, 5e7, shipStats('interceptor'), 1);
    expect(closest).toBeGreaterThanOrEqual(-1e-9);
    const altitude =
      final.frame === 'system' ? distance(final.pos, target.center) - target.radius : final.pos.y;
    expect(altitude).toBeLessThan(5);
  });

  it('even a ship forced to 1e7 m/s (100x any cruise) cannot get through: the swept test clamps it', () => {
    const cls = shipStats('scout');
    const world: FlightWorld = { bodies: [body], surface: () => flatSurface(0) };
    for (const speed of [1.2e6, 1e7, 1e9]) {
      const start: Vec3 = add(body.center, { x: 0, y: body.radius + 9e7, z: 0 });
      let s = restingShip(start, { vel: { x: 0, y: -speed, z: 0 } });
      let closest = Infinity;
      for (let i = 0; i < 400; i++) {
        s = stepShip(s, IDLE, 0.05, world, cls);
        closest = Math.min(
          closest,
          length(
            sub(
              s.frame === 'system'
                ? s.pos
                : add(body.center, { x: 0, y: body.radius + s.pos.y, z: 0 }),
              body.center,
            ),
          ) - body.radius,
        );
      }
      expect(closest, `${speed}`).toBeGreaterThanOrEqual(-1e-6);
    }
  });
});
