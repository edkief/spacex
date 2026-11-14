import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { shipStats } from '@shared/ships/catalog.ts';
import { CorruptRowError, NotFoundError } from './errors.ts';
import { STARTER_LIVERY } from './ships.ts';
import { describeBackends, uniqueCallsign } from './testing/backends.ts';

const position = (systemId: string) => ({
  systemId,
  frame: 'system' as const,
  x: 1.5,
  y: -2.25,
  z: 3,
});
const velocity = { x: 0.1, y: 0.2, z: -0.3 };

describeBackends('ships', (fx) => {
  const makePlayer = (home = 'sys-a') =>
    fx().repo.createPlayer({ callsign: uniqueCallsign(), homeSystemId: home });

  it('creates a docked starter scout from the catalog at the home system', async () => {
    const { repo } = fx();
    const player = await makePlayer('sys-home');
    const ship = await repo.getOrCreateStarterShip(player.id);
    const scout = shipStats('scout');
    expect(ship).toMatchObject({
      ownerId: player.id,
      classId: 'scout',
      hull: scout.hull,
      shields: scout.shieldCapacity,
      state: 'docked',
      livery: STARTER_LIVERY,
      position: { systemId: 'sys-home', x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    });
    expect(await repo.getShip(ship.id)).toEqual(ship);
  });

  it('is idempotent, even under concurrent calls', async () => {
    const { repo } = fx();
    const player = await makePlayer();
    const ships = await Promise.all(
      Array.from({ length: 8 }, () => repo.getOrCreateStarterShip(player.id)),
    );
    expect(new Set(ships.map((s) => s.id)).size).toBe(1);
    expect(await repo.listShipsByOwner(player.id)).toHaveLength(1);
  });

  it('gives a new starter once the old one is destroyed', async () => {
    const { repo } = fx();
    const player = await makePlayer();
    const first = await repo.getOrCreateStarterShip(player.id);
    await repo.saveShipState(first.id, {
      hull: 0,
      shields: 0,
      position: first.position,
      velocity: first.velocity,
      state: 'destroyed',
    });
    const second = await repo.getOrCreateStarterShip(player.id);
    expect(second.id).not.toBe(first.id);
    expect(await repo.listShipsByOwner(player.id)).toHaveLength(2);
  });

  it('raises NotFoundError for an unknown player', async () => {
    await expect(fx().repo.getOrCreateStarterShip('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('round-trips saved state, including fractional values and livery', async () => {
    const { repo, clock } = fx();
    const ship = await repo.getOrCreateStarterShip((await makePlayer()).id);
    clock.advance(5000);
    const saved = await repo.saveShipState(ship.id, {
      hull: 73.25,
      shields: 12.125,
      position: position('sys-b'),
      velocity,
      state: 'flying',
      livery: { hull: '#112233', accent: '#445566', trim: '#778899' },
    });
    expect(saved).toMatchObject({
      hull: 73.25,
      shields: 12.125,
      position: position('sys-b'),
      velocity,
      state: 'flying',
      livery: { hull: '#112233', accent: '#445566', trim: '#778899' },
      updatedAt: clock.now(),
    });
    expect(await repo.getShip(ship.id)).toEqual(saved);
  });

  it('keeps the livery when an update omits it', async () => {
    const { repo } = fx();
    const ship = await repo.getOrCreateStarterShip((await makePlayer()).id);
    const saved = await repo.saveShipState(ship.id, {
      hull: 1,
      shields: 1,
      position: ship.position,
      velocity: ship.velocity,
      state: 'docked',
    });
    expect(saved.livery).toEqual(STARTER_LIVERY);
  });

  it('raises NotFoundError when saving an unknown ship', async () => {
    const update = {
      hull: 1,
      shields: 1,
      position: position('s'),
      velocity,
      state: 'docked',
    } as const;
    await expect(fx().repo.saveShipState('ghost', update)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('validates JSON shapes and stats on write', async () => {
    const { repo } = fx();
    const ship = await repo.getOrCreateStarterShip((await makePlayer()).id);
    const good = {
      hull: 1,
      shields: 1,
      position: position('s'),
      velocity,
      state: 'docked',
    } as const;
    const bad: unknown[] = [
      { ...good, hull: -1 },
      { ...good, shields: Number.NaN },
      { ...good, state: 'exploding' },
      { ...good, position: { systemId: 's', x: 1, y: 2 } },
      { ...good, position: { ...position('s'), extra: 1 } },
      { ...good, velocity: { x: 'fast', y: 0, z: 0 } },
      { ...good, livery: { hull: 'red', accent: '#000000', trim: '#000000' } },
    ];
    for (const update of bad) {
      await expect(repo.saveShipState(ship.id, update as typeof good)).rejects.toThrow();
    }
    expect((await repo.getShip(ship.id))?.hull).toBe(shipStats('scout').hull);
  });

  it('validates JSON columns on read', async () => {
    const { repo, handle } = fx();
    const ship = await repo.getOrCreateStarterShip((await makePlayer()).id);
    const { ships } = handle.tables;
    await handle.run((db) =>
      db
        .update(ships)
        .set({ position: { nonsense: true } as never })
        .where(eq(ships.id, ship.id)),
    );
    await expect(repo.getShip(ship.id)).rejects.toBeInstanceOf(CorruptRowError);
    await expect(repo.listShipsByOwner(ship.ownerId)).rejects.toBeInstanceOf(CorruptRowError);
  });

  it('lists ships by owner and by system, excluding destroyed ones', async () => {
    const { repo } = fx();
    const system = `sys-list-${uniqueCallsign()}`;
    const p1 = await makePlayer(system);
    const p2 = await makePlayer(system);
    const a = await repo.getOrCreateStarterShip(p1.id);
    const b = await repo.getOrCreateStarterShip(p2.id);
    const moved = await repo.saveShipState(b.id, {
      hull: 10,
      shields: 10,
      position: position('elsewhere'),
      velocity,
      state: 'flying',
    });
    expect((await repo.listShipsInSystem(system)).map((s) => s.id)).toEqual([a.id]);
    expect((await repo.listShipsInSystem('elsewhere')).map((s) => s.id)).toEqual([moved.id]);
    await repo.saveShipState(a.id, {
      hull: 0,
      shields: 0,
      position: a.position,
      velocity: a.velocity,
      state: 'destroyed',
    });
    expect(await repo.listShipsInSystem(system)).toEqual([]);
    expect((await repo.listShipsByOwner(p1.id)).map((s) => s.id)).toEqual([a.id]);
  });

  it('enforces foreign keys: deleting a player cascades to ships', async () => {
    const { repo, handle } = fx();
    const player = await makePlayer();
    const ship = await repo.getOrCreateStarterShip(player.id);
    const { players } = handle.tables;
    await handle.run((db) => db.delete(players).where(eq(players.id, player.id)));
    expect(await repo.getShip(ship.id)).toBeUndefined();
  });

  it('saveShipSnapshots saves many ships and holds in one call and reports missing ships', async () => {
    const { repo } = fx();
    const a = await repo.getOrCreateStarterShip((await makePlayer()).id);
    const b = await repo.getOrCreateStarterShip((await makePlayer()).id);
    const base = { hull: 50, shields: 5, velocity, state: 'flying' } as const;
    const result = await repo.saveShipSnapshots([
      {
        shipId: a.id,
        update: { ...base, position: position('sys-snap') },
        cargo: [
          { resourceType: 'iron', quantity: 3 },
          { resourceType: 'water', quantity: 0 },
        ],
      },
      { shipId: 'ghost', update: { ...base, position: position('sys-snap') } },
      { shipId: b.id, update: { ...base, hull: 7, position: position('sys-snap') } },
    ]);
    expect(result).toEqual({ saved: [a.id, b.id], missing: ['ghost'] });
    expect(await repo.getShip(a.id)).toMatchObject({ hull: 50, position: position('sys-snap') });
    expect((await repo.getShip(b.id))?.hull).toBe(7);
    expect(await repo.getCargo(a.id)).toEqual([{ resourceType: 'iron', quantity: 3 }]);
    expect(await repo.getCargo(b.id)).toEqual([]);
  });

  it('saveShipSnapshots validates everything before writing anything', async () => {
    const { repo } = fx();
    const ship = await repo.getOrCreateStarterShip((await makePlayer()).id);
    const good = {
      hull: 1,
      shields: 1,
      velocity,
      state: 'docked',
      position: position('s'),
    } as const;
    await expect(
      repo.saveShipSnapshots([
        { shipId: ship.id, update: good },
        { shipId: ship.id, update: { ...good, hull: -5 } },
      ]),
    ).rejects.toThrow();
    expect((await repo.getShip(ship.id))?.hull).toBe(shipStats('scout').hull);
  });
});
