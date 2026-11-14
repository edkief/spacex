import { describe, expect, it } from 'vitest';
import { shipStats } from '@shared/ships/catalog.ts';
import { damageLevel } from './persist/hull.ts';
import { usePersistHarness } from './testing/persistHarness.ts';

const MAX_HULL = shipStats('scout').hull;

describe('damageLevel', () => {
  it('counts the 75/50/25% thresholds at or below the hull fraction', () => {
    expect(damageLevel(100, 100)).toBe(0);
    expect(damageLevel(76, 100)).toBe(0);
    expect(damageLevel(75, 100)).toBe(1);
    expect(damageLevel(50, 100)).toBe(2);
    expect(damageLevel(25, 100)).toBe(3);
    expect(damageLevel(0, 100)).toBe(3);
    expect(damageLevel(5, 0)).toBe(0);
  });
});

describe('persist service save points', () => {
  const h = usePersistHarness();
  const { makeShip, moved } = h;
  it('saveShip writes state and cargo in exactly one transaction', async () => {
    const ship = await makeShip();
    const live = {
      ...moved(ship, 1234.5),
      cargo: [
        { resourceType: 'iron', quantity: 4 },
        { resourceType: 'water', quantity: 2 },
      ],
    };
    await h.service.saveShip(live);
    expect(h.spy.calls['transaction']).toBe(1);
    expect(h.spy.calls['saveShipSnapshots']).toBe(1);
    expect((await h.fx.repo.getShip(ship.shipId))?.position.x).toBe(1234.5);
    expect(await h.fx.repo.getCargo(ship.shipId)).toEqual(live.cargo);
  });

  it('onDock saves immediately and clears the dirty flag', async () => {
    const ship = await makeShip();
    h.service.markDirty(moved(ship, 5));
    expect(h.service.isDirty(ship.shipId)).toBe(true);
    await h.service.onDock({ ...moved(ship, 9), state: 'docked' });
    expect(h.service.isDirty(ship.shipId)).toBe(false);
    expect(h.spy.calls['transaction']).toBe(1);
    expect(h.spy.calls['saveShipSnapshots']).toBe(1);
    expect(await h.fx.repo.getShip(ship.shipId)).toMatchObject({
      state: 'docked',
      position: { x: 9 },
    });
  });

  it('markDirty alone never writes; the interval save writes all dirty ships in one transaction', async () => {
    const ships = await Promise.all([makeShip(), makeShip(), makeShip()]);
    h.service.start();
    expect(h.scheduler.intervals[0]?.ms).toBe(5000);
    ships.forEach((ship, i) => h.service.markDirty(moved(ship, 100 + i)));
    expect(h.spy.calls['transaction'] ?? 0).toBe(0);
    expect(h.service.stats().dirtyShips).toBe(3);

    h.scheduler.tick();
    await h.service.flushDirty();
    expect(h.spy.calls['transaction']).toBe(1);
    expect(h.spy.calls['saveShipSnapshots']).toBe(1);
    expect(h.service.stats().dirtyShips).toBe(0);
    for (const [i, ship] of ships.entries()) {
      expect((await h.fx.repo.getShip(ship.shipId))?.position.x).toBe(100 + i);
    }
  });

  it('interval saves skip clean ships and do nothing when nothing is dirty', async () => {
    const [a, b] = await Promise.all([makeShip(), makeShip()]);
    h.service.markDirty(moved(a, 1));
    await h.service.flushDirty();
    h.spy.reset();
    const aSavedAt = (await h.fx.repo.getShip(a.shipId))?.updatedAt;
    h.fx.clock.advance(60_000);
    h.service.markDirty(moved(b, 2));
    await h.service.flushDirty();
    expect(h.spy.calls['saveShipSnapshots']).toBe(1);
    expect((await h.fx.repo.getShip(a.shipId))?.updatedAt).toEqual(aSavedAt);
    expect((await h.fx.repo.getShip(b.shipId))?.updatedAt).toEqual(h.fx.clock.now());
    h.spy.reset();
    await h.service.flushDirty();
    expect(h.spy.calls).toEqual({});
  });

  it('drives the interval save from the injected scheduler only', async () => {
    const ship = await makeShip();
    h.service.start();
    h.service.start();
    expect(h.scheduler.activeCount).toBe(1);
    h.service.markDirty(moved(ship, 77));
    h.scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await h.service.flushDirty();
    expect((await h.fx.repo.getShip(ship.shipId))?.position.x).toBe(77);
    h.service.stop();
    expect(h.scheduler.activeCount).toBe(0);
  });

  it('snapshots state at markDirty time, so later sim mutation does not leak into the save', async () => {
    const ship = await makeShip();
    const live = moved(ship, 10);
    h.service.markDirty(live);
    live.position.x = 99999;
    await h.service.flushDirty();
    expect((await h.fx.repo.getShip(ship.shipId))?.position.x).toBe(10);
  });

  describe('damage milestones', () => {
    it('saves exactly when hull newly crosses 75, 50 and 25 percent', async () => {
      const ship = await makeShip();
      h.service.track(ship);
      const hit = (hull: number) => h.service.onDamage({ ...ship, hull });
      const results: [number, boolean][] = [];
      for (const hull of [90, 80, 74, 70, 50, 49, 30, 25, 10, 1]) {
        results.push([hull, await hit(hull)]);
      }
      expect(results.filter(([, saved]) => saved).map(([hull]) => hull)).toEqual([74, 50, 25]);
      expect(h.spy.calls['saveShipSnapshots']).toBe(3);
      expect(MAX_HULL).toBe(100);
    });

    it('queues non-milestone damage for the interval save and can re-trigger after repair', async () => {
      const ship = await makeShip();
      h.service.track(ship);
      expect(await h.service.onDamage({ ...ship, hull: 90 })).toBe(false);
      expect(h.service.isDirty(ship.shipId)).toBe(true);
      expect(await h.service.onDamage({ ...ship, hull: 60 })).toBe(true);
      expect(h.service.isDirty(ship.shipId)).toBe(false);
      expect(await h.service.onDamage({ ...ship, hull: 95 })).toBe(false);
      expect(await h.service.onDamage({ ...ship, hull: 60 })).toBe(true);
    });

    it('uses one transaction per milestone save', async () => {
      const ship = await makeShip();
      await h.service.onDamage({ ...ship, hull: 70 });
      expect(h.spy.calls['transaction']).toBe(1);
    });
  });
});
