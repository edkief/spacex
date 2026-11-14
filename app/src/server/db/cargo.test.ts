import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { NotFoundError } from './errors.ts';
import { describeBackends, uniqueCallsign } from './testing/backends.ts';

describeBackends('cargo', (fx) => {
  const makeShip = async () => {
    const player = await fx().repo.createPlayer({
      callsign: uniqueCallsign(),
      homeSystemId: 'sys',
    });
    return fx().repo.getOrCreateStarterShip(player.id);
  };

  it('starts empty and round-trips a saved hold sorted by resource type', async () => {
    const { repo } = fx();
    const ship = await makeShip();
    expect(await repo.getCargo(ship.id)).toEqual([]);
    await repo.saveCargo(ship.id, [
      { resourceType: 'iron', quantity: 12 },
      { resourceType: 'copper', quantity: 3 },
    ]);
    expect(await repo.getCargo(ship.id)).toEqual([
      { resourceType: 'copper', quantity: 3 },
      { resourceType: 'iron', quantity: 12 },
    ]);
  });

  it('replaces the whole hold: updates, removals and zero quantities', async () => {
    const { repo } = fx();
    const ship = await makeShip();
    await repo.saveCargo(ship.id, [
      { resourceType: 'iron', quantity: 5 },
      { resourceType: 'water', quantity: 9 },
      { resourceType: 'silicon', quantity: 1 },
    ]);
    await repo.saveCargo(ship.id, [
      { resourceType: 'iron', quantity: 8 },
      { resourceType: 'silicon', quantity: 0 },
    ]);
    expect(await repo.getCargo(ship.id)).toEqual([{ resourceType: 'iron', quantity: 8 }]);
    await repo.saveCargo(ship.id, []);
    expect(await repo.getCargo(ship.id)).toEqual([]);
  });

  it('keeps ships separate and supports bulk reads', async () => {
    const { repo } = fx();
    const a = await makeShip();
    const b = await makeShip();
    await repo.saveCargo(a.id, [{ resourceType: 'iron', quantity: 1 }]);
    await repo.saveCargo(b.id, [{ resourceType: 'iron', quantity: 2 }]);
    const map = await repo.getCargoForShips([a.id, b.id, 'missing']);
    expect(map.get(a.id)).toEqual([{ resourceType: 'iron', quantity: 1 }]);
    expect(map.get(b.id)).toEqual([{ resourceType: 'iron', quantity: 2 }]);
    expect(map.get('missing')).toEqual([]);
    expect((await repo.getCargoForShips([])).size).toBe(0);
  });

  it('rejects duplicates, negatives and fractions without changing the hold', async () => {
    const { repo } = fx();
    const ship = await makeShip();
    await repo.saveCargo(ship.id, [{ resourceType: 'iron', quantity: 4 }]);
    const bad = [
      [
        { resourceType: 'iron', quantity: 1 },
        { resourceType: 'iron', quantity: 2 },
      ],
      [{ resourceType: 'iron', quantity: -1 }],
      [{ resourceType: 'iron', quantity: 1.5 }],
      [{ resourceType: '', quantity: 1 }],
    ];
    for (const items of bad) await expect(repo.saveCargo(ship.id, items)).rejects.toThrow();
    expect(await repo.getCargo(ship.id)).toEqual([{ resourceType: 'iron', quantity: 4 }]);
  });

  it('raises NotFoundError for an unknown ship', async () => {
    await expect(
      fx().repo.saveCargo('ghost', [{ resourceType: 'iron', quantity: 1 }]),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('enforces unique(ship_id, resource_type) at the database level', async () => {
    const { handle } = fx();
    const ship = await makeShip();
    const { cargoItems } = handle.tables;
    const row = { shipId: ship.id, resourceType: 'iron', quantity: 1 };
    await handle.run((db) => db.insert(cargoItems).values({ id: 'c1-' + ship.id, ...row }));
    await expect(
      handle.run((db) => db.insert(cargoItems).values({ id: 'c2-' + ship.id, ...row })),
    ).rejects.toThrow();
  });

  it('cascades when the ship is deleted', async () => {
    const { repo, handle } = fx();
    const ship = await makeShip();
    await repo.saveCargo(ship.id, [{ resourceType: 'iron', quantity: 1 }]);
    const { ships } = handle.tables;
    await handle.run((db) => db.delete(ships).where(eq(ships.id, ship.id)));
    expect(await repo.getCargo(ship.id)).toEqual([]);
  });
});
