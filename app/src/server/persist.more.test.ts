import { describe, expect, it } from 'vitest';
import { NotFoundError } from './db/errors.ts';
import { uniqueCallsign } from './db/testing/backends.ts';
import { createPersistService } from './persist.ts';
import { usePersistHarness } from './testing/persistHarness.ts';

describe('persist service behaviour', () => {
  const h = usePersistHarness();
  const { makeShip, moved } = h;

  describe('robustness', () => {
    it('keeps ships dirty when a flush fails and retries on the next one', async () => {
      const ship = await makeShip();
      h.service.markDirty(moved(ship, 42));
      h.failing.remaining = 1;
      await expect(h.service.flushDirty()).rejects.toThrow('injected');
      expect(h.service.isDirty(ship.shipId)).toBe(true);
      await h.service.flushDirty();
      expect(h.service.isDirty(ship.shipId)).toBe(false);
      expect((await h.fx.repo.getShip(ship.shipId))?.position.x).toBe(42);
    });

    it('reports background flush failures via onError and keeps going', async () => {
      const ship = await makeShip();
      h.service.start();
      h.service.markDirty(moved(ship, 7));
      h.failing.remaining = 1;
      h.scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.errors).toHaveLength(1);
      h.scheduler.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.service.isDirty(ship.shipId)).toBe(false);
    });

    it('keeps a ship dirty if it was re-marked while its flush was in flight', async () => {
      const ship = await makeShip();
      const real = h.spy.repo;
      let injected = false;
      // Simulate the sim mutating the ship while the save transaction is open.
      const racing = {
        ...real,
        transaction: <T>(fn: Parameters<typeof real.transaction<T>>[0]) =>
          real.transaction((tx) => {
            if (!injected) {
              injected = true;
              service.markDirty(moved(ship, 2));
            }
            return fn(tx);
          }),
      };
      const service = createPersistService(racing, { scheduler: h.scheduler });
      service.markDirty(moved(ship, 1));
      await service.flushDirty();
      expect(service.isDirty(ship.shipId)).toBe(true);
      await service.flushDirty();
      expect(service.isDirty(ship.shipId)).toBe(false);
      expect((await h.fx.repo.getShip(ship.shipId))?.position.x).toBe(2);
    });

    it('drops ships that no longer exist, reports them, and still saves the rest', async () => {
      const real = await makeShip();
      h.service.markDirty({ ...moved(real, 3) });
      h.service.markDirty({ ...moved(real, 3), shipId: 'deleted-ship' });
      const result = await h.service.flushDirty();
      expect(result.ships).toBe(1);
      expect(h.service.stats().dirtyShips).toBe(0);
      expect(h.errors[0]).toBeInstanceOf(NotFoundError);
    });

    it('rejects an immediate save of a missing ship', async () => {
      const ship = await makeShip();
      await expect(h.service.saveShip({ ...ship, shipId: 'ghost' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('cargo and node state', () => {
    it('rewrites a hold only when it changed', async () => {
      const { repo } = h.fx;
      const ship = await makeShip();
      const hold = [{ resourceType: 'iron', quantity: 1 }];
      await h.service.saveShip({ ...ship, cargo: hold });
      expect(await repo.getCargo(ship.shipId)).toEqual(hold);

      // Tamper behind the service's back: an unchanged hold must not be rewritten...
      await repo.saveCargo(ship.shipId, [{ resourceType: 'iron', quantity: 99 }]);
      await h.service.saveShip({ ...moved(ship, 1), cargo: [...hold] });
      expect(await repo.getCargo(ship.shipId)).toEqual([{ resourceType: 'iron', quantity: 99 }]);

      // ...but a changed hold is, and omitting cargo leaves it alone.
      await h.service.saveShip({ ...ship, cargo: [{ resourceType: 'iron', quantity: 2 }] });
      expect(await repo.getCargo(ship.shipId)).toEqual([{ resourceType: 'iron', quantity: 2 }]);
      await h.service.saveShip(ship);
      expect(await repo.getCargo(ship.shipId)).toEqual([{ resourceType: 'iron', quantity: 2 }]);
    });

    it('saveCargo and saveNodeStates write through the repository', async () => {
      const ship = await makeShip();
      await h.service.saveCargo(ship.shipId, [{ resourceType: 'water', quantity: 5 }]);
      const respawnAt = new Date(Date.UTC(2032, 0, 1));
      await h.service.saveNodeStates('sys-nodes', [
        { nodeId: 'n1', quantityRemaining: 0, respawnAt },
        { nodeId: 'n2', quantityRemaining: 9, respawnAt: null },
      ]);
      expect(await h.fx.repo.getCargo(ship.shipId)).toEqual([
        { resourceType: 'water', quantity: 5 },
      ]);
      expect(await h.fx.repo.listNodeStates('sys-nodes')).toEqual([
        { nodeId: 'n1', systemId: 'sys-nodes', quantityRemaining: 0, respawnAt },
        { nodeId: 'n2', systemId: 'sys-nodes', quantityRemaining: 9, respawnAt: null },
      ]);
    });

    it('batches dirty nodes with dirty ships in the same transaction', async () => {
      const ship = await makeShip();
      h.service.markDirty(moved(ship, 5));
      h.service.markNodeDirty({
        nodeId: 'dn1',
        systemId: 'sys-dn',
        quantityRemaining: 1,
        respawnAt: null,
      });
      const result = await h.service.flushDirty();
      expect(result).toMatchObject({ ships: 1, nodes: 1 });
      expect(h.spy.calls['transaction']).toBe(1);
      expect(await h.fx.repo.listNodeStates('sys-dn')).toHaveLength(1);
    });
  });

  describe('shutdown', () => {
    it('onShardShutdown flushes only that system', async () => {
      const a = await makeShip('sys-shut-a');
      const b = await makeShip('sys-shut-b');
      h.service.markDirty(moved(a, 11));
      h.service.markDirty(moved(b, 22));
      h.service.markNodeDirty({
        nodeId: 'sn-a',
        systemId: 'sys-shut-a',
        quantityRemaining: 3,
        respawnAt: null,
      });
      h.service.markNodeDirty({
        nodeId: 'sn-b',
        systemId: 'sys-shut-b',
        quantityRemaining: 4,
        respawnAt: null,
      });
      const result = await h.service.onShardShutdown('sys-shut-a');
      expect(result).toMatchObject({ ships: 1, nodes: 1 });
      expect(h.service.isDirty(a.shipId)).toBe(false);
      expect(h.service.isDirty(b.shipId)).toBe(true);
      expect((await h.fx.repo.getShip(b.shipId))?.position.x).toBe(0);
    });

    it('shutdown stops the timer and flushes everything', async () => {
      const a = await makeShip();
      const b = await makeShip();
      h.service.start();
      h.service.markDirty(moved(a, 31));
      h.service.markDirty(moved(b, 32));
      const result = await h.service.shutdown();
      expect(result.ships).toBe(2);
      expect(h.scheduler.activeCount).toBe(0);
      expect(h.service.stats()).toEqual({ dirtyShips: 0, dirtyNodes: 0 });
    });
  });

  describe('loadSystemState', () => {
    it('returns persisted ships with holds and node states, excluding destroyed ships', async () => {
      const system = `sys-load-${uniqueCallsign()}`;
      const alive = await makeShip(system);
      const dead = await makeShip(system);
      await h.service.saveShip({
        ...alive,
        hull: 40,
        cargo: [{ resourceType: 'iron', quantity: 6 }],
      });
      await h.service.saveShip({ ...dead, hull: 0, state: 'destroyed' });
      await h.service.saveNodeStates(system, [
        { nodeId: `${system}-n`, quantityRemaining: 8, respawnAt: null },
      ]);

      const loaded = await h.service.loadSystemState(system);
      expect(loaded.ships).toHaveLength(1);
      expect(loaded.ships[0]).toMatchObject({
        id: alive.shipId,
        hull: 40,
        cargo: [{ resourceType: 'iron', quantity: 6 }],
      });
      expect(loaded.nodeStates).toHaveLength(1);
    });

    it('tracks loaded ships so only new threshold crossings trigger saves', async () => {
      const system = `sys-track-${uniqueCallsign()}`;
      const ship = await makeShip(system);
      await h.service.saveShip({ ...ship, hull: 40 });
      const fresh = createPersistService(h.spy.repo, { scheduler: h.scheduler });
      await fresh.loadSystemState(system);
      h.spy.reset();
      expect(await fresh.onDamage({ ...ship, hull: 35 })).toBe(false);
      expect(await fresh.onDamage({ ...ship, hull: 20 })).toBe(true);
    });
  });
});
