import { afterAll, beforeAll, beforeEach } from 'vitest';
import { openFixture, uniqueCallsign, type Fixture } from '../db/testing/backends.ts';
import { createPersistService, type LiveShip, type PersistService } from '../persist.ts';
import { FakeScheduler, spyOnRepository, type Spy } from './persistHelpers.ts';

/** Per-test persist-service setup over one shared SQLite database; call inside a describe. */
export function usePersistHarness() {
  let fx: Fixture;
  let spy: Spy;
  let scheduler: FakeScheduler;
  let service: PersistService;
  let errors: unknown[];
  const failing = { remaining: 0 };

  beforeAll(async () => {
    fx = await openFixture('sqlite');
  });
  afterAll(async () => {
    await fx.close();
  });
  beforeEach(() => {
    spy = spyOnRepository(fx.repo, failing);
    scheduler = new FakeScheduler();
    errors = [];
    failing.remaining = 0;
    service = createPersistService(spy.repo, { scheduler, onError: (e) => errors.push(e) });
  });

  /** Creates a player with a starter ship and returns the live view of it. */
  async function makeShip(systemId = `sys-${uniqueCallsign()}`): Promise<LiveShip> {
    const player = await fx.repo.createPlayer({
      callsign: uniqueCallsign(),
      homeSystemId: systemId,
    });
    const ship = await fx.repo.getOrCreateStarterShip(player.id);
    spy.reset();
    return {
      shipId: ship.id,
      classId: 'scout',
      hull: ship.hull,
      shields: ship.shields,
      position: { ...ship.position },
      velocity: { ...ship.velocity },
      state: 'docked',
    };
  }

  const moved = (ship: LiveShip, x: number): LiveShip => ({
    ...ship,
    position: { ...ship.position, x },
    state: 'flying',
  });

  return {
    get fx() {
      return fx;
    },
    get spy() {
      return spy;
    },
    get scheduler() {
      return scheduler;
    },
    get service() {
      return service;
    },
    get errors() {
      return errors;
    },
    failing,
    makeShip,
    moved,
  };
}
