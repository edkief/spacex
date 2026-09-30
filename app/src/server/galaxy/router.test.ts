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
import { homeDockPosition } from '@shared/galaxy/dock';
import { homeSystemIdForPlayer } from '@shared/galaxy/home';
import { MAX_PLAYERS_PER_SYSTEM } from '@shared/protocol';
import type { StateSnapshot } from '@shared/protocol/schemas';
import { SHARD_LOAD_BUDGET_MS, createGalaxyRouter, type GalaxyRouterDeps } from './router';

/**
 * TASK-11 router unit tests: idempotent + collapsed concurrent shard loads,
 * the 60 s reap grace (fake clock, ships flushed first), the 16-player cap,
 * and the restart test (same world after a "process" restart: positions from
 * the DB, system generation identical given the seed).
 */

const GALAXY_SEED = 'router-unit-seed-001';
/**
 * System ids (hash of seed+starId — NOT the star ids) for the first stars,
 * plus the full valid set (for the unknown-id probe).
 */
const stars = generateStars(GALAXY_SEED);
const systemIds = stars.slice(0, 8).map((s) => generateSystem(GALAXY_SEED, s.id).systemId);
const allSystemIds = new Set(stars.map((s) => generateSystem(GALAXY_SEED, s.id).systemId));
const unknownSystemId = (() => {
  let id = '0'.repeat(16);
  while (allSystemIds.has(id)) id = (BigInt(id) + 1n).toString(16).padStart(16, '0');
  return id;
})();

/** Fake clock (epoch ms) advanced manually by the reap tests. */
let fakeNow = 1_700_000_000_000;

let dir: string;
let repo: Repository;
let bus: ReturnType<typeof createShipSwapBus>;

function makeRouter(overrides: Partial<GalaxyRouterDeps> = {}) {
  return createGalaxyRouter({
    repo,
    galaxySeed: GALAXY_SEED,
    shipSwapBus: bus,
    now: () => fakeNow,
    ...overrides,
  });
}

/** A player with a starter ship docked in `systemId` (claim route logic). */
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

function dist3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function snapshotOf(res: { ok: boolean }): StateSnapshot {
  if (!res.ok) throw new Error(`expected ok enter, got ${JSON.stringify(res)}`);
  return (res as { ok: true; snapshot: StateSnapshot }).snapshot;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-router-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'router.db') });
  repo = createRepo(db, sqliteTables);
  bus = createShipSwapBus();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('galaxy router (TASK-11)', () => {
  it('getShard is idempotent and collapses 10 concurrent loads of 3 systems', async () => {
    const router = makeRouter();
    const ids = [systemIds[0], systemIds[1], systemIds[2]];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => router.getShard(ids[i % 3])),
    );
    expect(results.every((r) => r !== undefined)).toBe(true);
    // 10 joins across 3 systems → exactly 3 shards, one per system.
    expect(router.stats()).toHaveLength(3);
    // Same instance everywhere (pending-promise collapse, no double load).
    for (let i = 0; i < 10; i++) {
      expect(router.active(ids[i % 3])).toBe(results[i]);
    }
    // Load budget: a typical system loads in under 500 ms.
    for (const active of results) {
      expect(active!.loadMs).toBeLessThanOrEqual(SHARD_LOAD_BUDGET_MS);
      expect(active!.shard.systemId).toBe(ids[results.indexOf(active!) % 3]);
    }
    await router.stopAll();
    expect(router.stats()).toHaveLength(0);
  }, 15000);

  it('resolves unknown system ids to undefined', async () => {
    const router = makeRouter();
    expect(await router.getShard(unknownSystemId)).toBeUndefined();
    expect(router.stats()).toHaveLength(0);
  });

  it('reaps an empty shard after the 60 s grace, flushing ships first', async () => {
    const systemId = systemIds[3];
    const router = makeRouter();
    const p = await makePlayer('Reap-Pilot', systemId);
    const res = await router.enter(systemId, p);
    expect(res.ok).toBe(true);
    expect(router.stats()).toHaveLength(1);

    // All players leave → the grace clock starts exactly at the last leave.
    router.leave(systemId, p.playerId);
    expect(router.active(systemId)!.shard.connections.size).toBe(0);

    // Just before 60 s: still alive.
    fakeNow += 59_000;
    expect(await router.reapEmpty()).toBe(0);
    expect(router.stats()).toHaveLength(1);

    // Past the grace: reaped — ships flushed to the DB first, shard gone.
    fakeNow += 2_000;
    expect(await router.reapEmpty()).toBe(1);
    expect(router.stats()).toHaveLength(0);
    expect(router.active(systemId)).toBeUndefined();

    const row = await repo.getShipByOwner(p.playerId);
    expect(row).toBeDefined();
    expect(row!.state).toBe('docked');
    expect(row!.position).toEqual({ systemId, ...homeDockPosition(GALAXY_SEED, systemId) });
  }, 15000);

  it('rejoining during the grace cancels the reap', async () => {
    const systemId = systemIds[4];
    const router = makeRouter();
    const p = await makePlayer('Grace-Pilot', systemId);
    await router.enter(systemId, p);
    router.leave(systemId, p.playerId);
    fakeNow += 30_000;

    // Back within the window: the pending grace is void.
    const again = await router.enter(systemId, p);
    expect(again.ok).toBe(true);
    expect(snapshotOf(again).systemId).toBe(systemId);

    // Even well past the original grace start, the shard survives.
    fakeNow += 180_000;
    expect(await router.reapEmpty()).toBe(0);
    expect(router.stats()).toHaveLength(1);
    await router.stopAll();
  }, 15000);

  it('enforces the 16-player cap with a system-full rejection', async () => {
    const systemId = systemIds[5];
    const router = makeRouter();
    const players = [];
    for (let i = 0; i < MAX_PLAYERS_PER_SYSTEM; i++) {
      const p = await makePlayer(`Cap-Pilot-${i}`, systemId);
      players.push(p);
      const res = await router.enter(systemId, p);
      expect(res.ok).toBe(true);
    }
    expect(router.active(systemId)!.shard.connections.size).toBe(MAX_PLAYERS_PER_SYSTEM);

    // The 17th is rejected; the 16 keep their slots.
    const overflow = await makePlayer('Cap-Overflow', systemId);
    const denied = await router.enter(systemId, overflow);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('system-full');
    expect(router.active(systemId)!.shard.connections.size).toBe(MAX_PLAYERS_PER_SYSTEM);

    // A slot frees up → the 17th can join again.
    router.leave(systemId, players[0].playerId);
    const retry = await router.enter(systemId, overflow);
    expect(retry.ok).toBe(true);
    await router.stopAll();
  }, 30000);

  it('restart: rejoining after a server restart yields the same world', async () => {
    const systemId = systemIds[6];
    const first = makeRouter();
    const p = await makePlayer('Restart-Pilot', systemId);
    const entered = await first.enter(systemId, p);
    expect(entered.ok).toBe(true);

    // Fly for a moment (real sim time), then let the ship coast.
    const shard = first.active(systemId)!.shard;
    shard.enqueueInput(p.playerId, {
      seq: 1,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
    });
    await sleep(300);
    shard.enqueueInput(p.playerId, {
      seq: 2,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
    });
    await sleep(100);
    const entity = [...shard.entities.values()].find((e) => e.playerId === p.playerId)!;
    const posBefore = { ...entity.ship.pos };
    const velBefore = { ...entity.ship.vel };
    const systemBefore = first.active(systemId)!.system;
    expect(dist3(posBefore, homeDockPosition(GALAXY_SEED, systemId))).toBeGreaterThan(1);

    // "Process" exit: stop + flush everything (graceful shutdown path).
    await first.stopAll();
    expect(first.stats()).toHaveLength(0);
    const row = await repo.getShipByOwner(p.playerId);
    expect(row!.state).toBe('flying');
    expect(dist3(row!.position, posBefore)).toBeLessThan(5);

    // Fresh process, same DB + seed: the same world.
    const second = makeRouter();
    const reentered = await second.enter(systemId, { playerId: p.playerId, callsign: p.callsign });
    expect(reentered.ok).toBe(true);
    const snap = snapshotOf(reentered);
    const me = snap.entities.find((e) => e.id === p.shipId)!;
    // Position resumes from the DB (a few ticks of coasting at most), not
    // from the dock — no spawn teleport.
    expect(dist3(me.pos, row!.position)).toBeLessThan(5);
    expect(dist3(me.pos, homeDockPosition(GALAXY_SEED, systemId))).toBeGreaterThan(1);
    // Velocity survived the restart exactly (space coast, no inputs held).
    expect(me.vel).toEqual(velBefore);
    // Same world given the seed: the regenerated system is identical
    // (planets — and with them the future AI placement, TASK-45/46 — match).
    const systemAfter = second.active(systemId)!.system;
    expect(systemAfter.name).toBe(systemBefore.name);
    expect(systemAfter.planets.map((pl) => pl.id)).toEqual(systemBefore.planets.map((pl) => pl.id));
    expect(systemAfter.planets.map((pl) => pl.name)).toEqual(
      systemBefore.planets.map((pl) => pl.name),
    );
    await second.stopAll();
  }, 20000);
});
