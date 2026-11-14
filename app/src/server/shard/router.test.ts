import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listSpawnSystems } from '@shared/galaxy/spawn.ts';
import { openFixture, type Fixture } from '../db/testing/backends.ts';
import type { DirectoryPlayer } from '../directory.ts';
import { FakeTimers } from '../testing/fakeTimers.ts';
import { MAX_PLAYERS_PER_SYSTEM, REAP_GRACE_MS, createShardRouter } from './router.ts';

const SEED = 'drift-dev-seed-001';
const SYSTEMS = listSpawnSystems(SEED).map((spawn) => spawn.systemId);

describe('shard router', () => {
  let fixture: Fixture;
  let n = 0;

  beforeAll(async () => {
    fixture = await openFixture('sqlite');
  });
  afterAll(async () => fixture.close());

  async function pilot(): Promise<DirectoryPlayer> {
    n += 1;
    const callsign = `ROUTER-${n}`;
    const player = await fixture.repo.createPlayer({ callsign, homeSystemId: SYSTEMS[0]! });
    const ship = await fixture.repo.getOrCreateStarterShip(player.id);
    return { playerId: player.id, callsign, shipId: ship.id, sink: { send: () => undefined } };
  }
  const setup = (capacity?: number) => {
    const timers = new FakeTimers(0);
    const router = createShardRouter({
      seed: SEED,
      repo: fixture.repo,
      timers,
      now: timers.now,
      ...(capacity === undefined ? {} : { capacity }),
    });
    return { timers, router };
  };

  it('rejects unknown systems and starts a shard on first join', async () => {
    const { router } = setup();
    expect(await router.join('ffffffffffffffff', await pilot())).toMatchObject({
      ok: false,
      code: 'system-not-found',
    });
    expect(router.stats()).toEqual([]);
    const joined = await router.join(SYSTEMS[0]!, await pilot());
    expect(joined.ok).toBe(true);
    expect(router.stats()).toMatchObject([{ systemId: SYSTEMS[0], players: 1 }]);
    await router.shutdown();
    expect(router.stats()).toEqual([]);
  });

  it('caps a system at 16 players with system-full, but lets a present player rejoin', async () => {
    expect(MAX_PLAYERS_PER_SYSTEM).toBe(16);
    const { router } = setup(2);
    const a = await pilot();
    await router.join(SYSTEMS[0]!, a);
    await router.join(SYSTEMS[0]!, await pilot());
    expect(await router.join(SYSTEMS[0]!, await pilot())).toMatchObject({
      ok: false,
      code: 'system-full',
    });
    expect((await router.join(SYSTEMS[0]!, a)).ok).toBe(true);
    await router.shutdown();
  });

  it('runs systems independently: several shards tick side by side with no shared entities', async () => {
    const { router, timers } = setup();
    const pilots = [await pilot(), await pilot(), await pilot()];
    await Promise.all(pilots.map((p, i) => router.join(SYSTEMS[i]!, p)));
    timers.advance(1000);
    const stats = router.stats();
    expect(stats).toHaveLength(3);
    for (const entry of stats) expect(entry.tick).toBe(20);
    pilots.forEach((p, i) => {
      expect(
        router
          .shard(SYSTEMS[i]!)!
          .snapshot(p.playerId)
          .entities.map((e) => e.id),
      ).toEqual([p.shipId]);
    });
    await router.shutdown();
  });

  it('reaps an empty shard after the 60 s grace, saving its ships, unless someone returns', async () => {
    const { router, timers } = setup();
    const a = await pilot();
    await router.join(SYSTEMS[1]!, a);
    router.input(SYSTEMS[1]!, a.playerId, {
      seq: 1,
      thrust: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      up: 0,
      brake: false,
      fire: false,
      lock: false,
      action: 'undock',
    });
    timers.advance(500);
    await router.leave(SYSTEMS[1]!, a.playerId, a.sink);
    timers.advance(REAP_GRACE_MS - 1000);
    expect(router.stats()).toHaveLength(1);
    // Returning inside the grace period cancels the reap and reuses the same shard.
    const shard = router.shard(SYSTEMS[1]!);
    await router.join(SYSTEMS[1]!, a);
    timers.advance(REAP_GRACE_MS + 1000);
    expect(router.shard(SYSTEMS[1]!)).toBe(shard);
    await router.leave(SYSTEMS[1]!, a.playerId, a.sink);
    timers.advance(REAP_GRACE_MS + 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.stats()).toEqual([]);
    const stored = await fixture.repo.getShip(a.shipId);
    expect(stored!.position.systemId).toBe(SYSTEMS[1]);
    expect(stored!.state).toBe('flying');
  });
});
