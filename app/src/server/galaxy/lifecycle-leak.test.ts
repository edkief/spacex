import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from '@server/db/client';
import { createRepo, type Repository } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { createShipSwapBus } from '@server/shards';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { homeSystemIdForPlayer } from '@shared/galaxy/home';
import { homeDockPosition } from '@shared/galaxy/dock';
import { MAX_PLAYERS_PER_SYSTEM } from '@shared/protocol';
import { createGalaxyRouter, type GalaxyRouterDeps } from './router';

/**
 * TASK-12 leak + reconnect-storm tests (router level):
 * 100 join/leave cycles across 5 systems leave EXACTLY 0 active shards and
 * no new active handles (no leaked timers/DB connections); a 16-client
 * storm where everyone leaves and 10 rejoin within 2 s REUSES the same
 * shard (same instance, same generation — no reload from DB mid-flight).
 */

const GALAXY_SEED = 'lifecycle-leak-seed-001';
const stars = generateStars(GALAXY_SEED);
const systemIds = stars.slice(0, 8).map((s) => generateSystem(GALAXY_SEED, s.id).systemId);

let dir: string;
let repo: Repository;
let bus: ReturnType<typeof createShipSwapBus>;
let fakeNow = 1_700_000_000_000;

function makeRouter(overrides: Partial<GalaxyRouterDeps> = {}) {
  return createGalaxyRouter({
    repo,
    galaxySeed: GALAXY_SEED,
    shipSwapBus: bus,
    now: () => fakeNow,
    ...overrides,
  });
}

/** A player with a starter ship (claim route logic). */
async function makePlayer(callsign: string, systemId: string) {
  const playerId = randomUUID();
  await repo.createPlayer({
    callsign,
    homeSystemId: homeSystemIdForPlayer(GALAXY_SEED, playerId),
    id: playerId,
  });
  const ship = await repo.getOrCreateStarterShip(playerId, {
    classId: 'scout',
    position: { systemId, ...homeDockPosition(GALAXY_SEED, systemId) },
  });
  return { playerId, callsign, shipId: ship.id };
}

/** Active handles counted by constructor name (leak detection baseline). */
function countActiveHandles(): Map<string, number> {
  const proc = process as NodeJS.Process & { _getActiveHandles?: () => unknown[] };
  const handles = proc._getActiveHandles?.() ?? [];
  const counts = new Map<string, number>();
  for (const h of handles) {
    const ctor = (h as { constructor?: { name?: string } })?.constructor;
    const name = ctor?.name ?? 'unknown';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-lifecycle-leak-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'leak.db') });
  repo = createRepo(db, sqliteTables);
  bus = createShipSwapBus();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('shard lifecycle leaks + storm (TASK-12)', () => {
  it('100 join/leave cycles across 5 systems leave 0 shards and no new active handles', async () => {
    const baseline = countActiveHandles();
    // Short (1 s) grace so each cycle's empty shard can be reaped on demand.
    const router = makeRouter({ graceMs: 1_000 });

    for (let cycle = 0; cycle < 100; cycle++) {
      const systemId = systemIds[cycle % 5];
      const p = await makePlayer(`Leak-${cycle}`, systemId);
      const res = await router.enter(systemId, p);
      expect(res.ok, `cycle ${cycle} enter failed`).toBe(true);
      router.leave(systemId, p.playerId);
      fakeNow += 1_100; // past the 1 s reap grace
    }
    // Reap until nothing is left (grace stamping takes one pass per shard).
    let reaped = 1;
    while (reaped > 0) reaped = await router.reapEmpty();

    // Exactly zero active shards…
    expect(router.stats()).toHaveLength(0);
    expect(systemIds.slice(0, 5).map((id) => router.active(id))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // …and no NEW kind or extra instance of active handle (a leaked sim
    // timer or DB handle would show up here).
    const after = countActiveHandles();
    expect(after.size).toBeLessThanOrEqual(baseline.size);
    for (const [name, count] of baseline) {
      expect(after.get(name) ?? 0, `handle type ${name} grew after the cycles`).toBeLessThanOrEqual(
        count,
      );
    }
  }, 60000);

  it('reconnect storm: 16 join, all leave, 10 rejoin in <2 s → shard reused (no reload)', async () => {
    const router = makeRouter(); // real clock, default 60 s grace
    const systemId = systemIds[5];

    // 16 clients join the same system at once (exactly the 16-player cap).
    const players: Array<Awaited<ReturnType<typeof makePlayer>>> = [];
    for (let i = 0; i < MAX_PLAYERS_PER_SYSTEM; i++) {
      players.push(await makePlayer(`Storm-${i}`, systemId));
    }
    const joins = await Promise.all(players.map((p) => router.enter(systemId, p)));
    expect(joins.every((r) => r.ok)).toBe(true);
    const first = router.active(systemId)!;
    expect(first.shard.connections.size).toBe(MAX_PLAYERS_PER_SYSTEM);
    expect(first.generation).toBe(1);

    // Everyone leaves at once → the shard is empty but still inside its grace.
    for (const p of players) router.leave(systemId, p.playerId);
    expect(first.shard.connections.size).toBe(0);

    // 10 of them rejoin within 2 s (well inside the 60 s grace): the SAME
    // shard instance serves them — no reload from DB mid-flight.
    const t0 = Date.now();
    const rejoins = await Promise.all(players.slice(0, 10).map((p) => router.enter(systemId, p)));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(rejoins.every((r) => r.ok)).toBe(true);
    const second = router.active(systemId)!;
    expect(second, 'shard was reused, not respawned').toBe(first);
    expect(second.generation, 'no (re)load from the DB').toBe(first.generation);
    expect(second.shard.connections.size).toBe(10);

    // For contrast: a spawn AFTER a full stop is a fresh generation.
    await router.stopAll();
    const respawned = await router.enter(systemId, players[0]);
    expect(respawned.ok).toBe(true);
    const third = router.active(systemId)!;
    expect(third).not.toBe(second);
    expect(third.generation).toBe(second.generation + 1);
    await router.stopAll();
    expect(router.stats()).toHaveLength(0);
  }, 30000);
});
