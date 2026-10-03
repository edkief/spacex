import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { createDb } from '@server/db/client';
import { createRepo, type Repository } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { createTokenCodec } from '@server/auth/token';
import { createSessionService, createTokenAuthenticate } from '@server/auth/session';
import { registerApiRoutes } from '@server/routes';
import { createShipSwapBus } from '@server/shards';
import { attachWebSocket, createRegistryGateway } from '@server/ws';
import { SystemShard } from '@server/shard';
import { WsTestClient, joinSystem, type WsEnvelope } from '@server/ws-test-client';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { quatFromEuler } from '@shared/physics/vec';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';

/**
 * The TASK-43 integration acceptance criterion over REAL websocket clients:
 * ship A fires at B (the fire INTENT travels over the wire and is routed
 * through onGameMessage → shard.handleFire, exactly like production's
 * routeGameMessage 'fire' branch), B's shields drop in the shard state, and
 * C — which fires nothing — sees the FX events in order on its own socket.
 */

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'weapons-test-secret',
  GALAXY_SEED: 'weapons-ws-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
  SHARD_FLUSH_INTERVAL_MS: 30000,
};

let dir: string;
let app: FastifyInstance;
let repo: Repository;
let shard: SystemShard;
let wsUrl: string;
let httpUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-weapons-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'weapons.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({
    repo,
    codec: createTokenCodec('weapons-test-secret'),
  });
  const bus = createShipSwapBus();

  const star = generateStars(env.GALAXY_SEED, 4)[0];
  const system = generateSystem(env.GALAXY_SEED, star.id);
  await repo.upsertSystem(system.systemId, system.name, true);
  shard = new SystemShard({
    systemId: system.systemId,
    galaxySeed: env.GALAXY_SEED,
    system,
    repo,
    shipSwapBus: bus,
  });
  shard.start();

  app = buildServer(env);
  registerApiRoutes(app, { repo, sessions, galaxySeed: env.GALAXY_SEED, shipSwapBus: bus });
  const handle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: createRegistryGateway(repo),
    authenticate: createTokenAuthenticate(sessions),
    // The ONE wiring difference vs the combat test: the fire INTENT is
    // routed to the sim, mirroring production's routeGameMessage 'fire'
    // branch (shards.ts) — the intent travels over the wire, not a direct
    // handleFire call.
    onGameMessage: (conn, type, payload) => {
      if (type === 'fire' && conn.playerId) {
        shard.handleFire(conn.playerId, payload as { weapon: string; targetId?: string }, conn);
      }
    },
    onJoinSystem: async (conn, systemId) => {
      if (systemId !== system.systemId || !conn.playerId || !conn.callsign) return;
      // Mirror the router's join order (production path): reserve the slot
      // with the WS conn registered AS the stale-conn source (shard.join
      // alone omits it, and handleFire would then drop every fire frame as
      // stale), then adopt the ship entity.
      shard.registerConnection(
        conn.playerId,
        conn.callsign,
        (buffer) => {
          if (conn.socket.readyState === 1) conn.socket.send(buffer); // WebSocket.OPEN
        },
        conn,
      );
      await shard.adoptEntity(conn.playerId, conn.callsign);
    },
    onLeaveSystem: (conn, systemId) => {
      if (systemId === system.systemId) shard.leave(conn);
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}${env.WS_PATH}`;
  closeServer = async () => {
    shard.stop();
    await handle.close();
    await app.close();
  };
});

afterAll(async () => {
  await closeServer();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function claim(
  callsign: string,
): Promise<{ token: string; playerId: string; shipId: string }> {
  const res = await fetch(`${httpUrl}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  if (res.status !== 201) {
    throw new Error(`claim ${callsign} -> ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { token: string; playerId: string; shipId: string };
}

async function join(callsign: string): Promise<{
  client: WsTestClient;
  playerId: string;
  shipId: string;
}> {
  const p = await claim(callsign);
  const client = new WsTestClient(wsUrl);
  await joinSystem(client, p.token, shard.systemId);
  for (
    let i = 0;
    i < 100 && ![...shard.entities.values()].some((e) => e.playerId === p.playerId);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const entity = [...shard.entities.values()].find((e) => e.playerId === p.playerId);
  expect(entity).toBeDefined();
  return { client, playerId: p.playerId, shipId: p.shipId };
}

function isCombat(m: WsEnvelope): m is WsEnvelope & { payload: Record<string, unknown> } {
  return m.type === 'combat_event' && typeof m.payload === 'object' && m.payload !== null;
}

function isKind(kind: string) {
  return (m: WsEnvelope) => isCombat(m) && m.payload.kind === kind;
}

/** Poll the shard state (20 ms) until the ship's shields reach `value`. */
async function waitForShields(shipId: string, value: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Math.abs(shard.entities.get(shipId)!.shields - value) > 1e-9) {
    if (Date.now() > deadline) {
      throw new Error(
        `shields of ${shipId} still ${shard.entities.get(shipId)!.shields}, want ${value}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Park A + B 60 m apart in open space and wait out the regime re-resolve. */
async function parkInSpace(aPlayerId: string, bPlayerId: string, posA: object, posB: object) {
  expect(shard.teleportForTesting(aPlayerId, posA as { x: number; y: number; z: number })).toBe(
    true,
  );
  expect(shard.teleportForTesting(bPlayerId, posB as { x: number; y: number; z: number })).toBe(
    true,
  );
  await new Promise((r) => setTimeout(r, 400));
}

describe('weapons over live ws (TASK-43 step: A fires at B, B shields drop, C sees the FX)', () => {
  it('laser: the fire frame over the wire drops B shields by 8; C sees laser-fired then hit', async () => {
    const a = await join('Weapons-Alpha');
    const b = await join('Weapons-Bravo');
    const c = await join('Weapons-Charlie'); // the observer: fires nothing
    await parkInSpace(
      a.playerId,
      b.playerId,
      { x: 60000, y: 60000, z: 0 },
      { x: 60060, y: 60000, z: 0 },
    );
    const eA = shard.entities.get(a.shipId)!;
    const eB = shard.entities.get(b.shipId)!;
    expect(eA.ship.regime).toBe('space');
    expect(eB.ship.regime).toBe('space');

    // The fire INTENT over the wire (routed by onGameMessage → handleFire);
    // the laser resolves on the next tick.
    a.client.send({
      v: PROTOCOL_VERSION,
      type: 'fire',
      payload: { weapon: 'laser', targetId: b.shipId },
    });

    // (a) B's shields drop to 1 − 8/50 in the shard state (scout: 50 shields).
    await waitForShields(b.shipId, 1 - 8 / 50);
    expect(eB.hull).toBe(1);

    // (b) C sees the beam, then the damage, IN ORDER on its own socket.
    const fired = await c.client.next(isKind('laser-fired'), 'laser-fired event', 5000);
    expect(fired.payload).toMatchObject({
      kind: 'laser-fired',
      source: { kind: 'player', id: a.playerId },
      weapon: 'laser',
    });
    const hit = await c.client.next(isKind('hit'), 'hit event', 5000);
    expect(hit.payload).toEqual({
      kind: 'hit',
      target: b.shipId,
      source: { kind: 'player', id: a.playerId },
      weapon: 'laser',
      damage: 8,
      shieldHit: 8,
      hullHit: 0,
    });

    // (c) A paid the 2-u laser cost at acceptance (energy materialized to 100
    // on the first tick): 98 plus a little 0.5 u/tick regen, never undefined.
    expect(eA.energy).toBeGreaterThan(97.5);
    expect(eA.energy).toBeLessThanOrEqual(100);

    a.client.close();
    b.client.close();
    c.client.close();
  }, 20000);

  it('missile: C sees missile-fired → missile-impact → hit (25); the projectile is a real entity in flight, gone after impact', async () => {
    const a = await join('Wpn-Alpha-2');
    const b = await join('Wpn-Bravo-2');
    const c = await join('Wpn-Charlie-2');
    await parkInSpace(
      a.playerId,
      b.playerId,
      { x: 70000, y: 70000, z: 0 },
      { x: 70060, y: 70000, z: 0 },
    );
    const eA = shard.entities.get(a.shipId)!;
    // Face A at B (B is at +x): the homing missile then flies straight in
    // (~0.5 s to 60 m) instead of spending its 5 s ttl on turn-rate-capped
    // tracking of an unaimed spawn heading.
    eA.ship.quat = quatFromEuler(Math.PI / 2, 0, 0);
    // The claimed class is a scout (laser-only loadout): mutate the entity
    // directly to an interceptor (the unit tests' proven path) so the
    // missile passes the loadout gate.
    eA.classId = 'interceptor';

    a.client.send({
      v: PROTOCOL_VERSION,
      type: 'fire',
      payload: { weapon: 'missile', targetId: b.shipId },
    });

    // The projectile is a REAL entity: present in shard.entities while in
    // flight (spawns on the next tick)…
    let projectileId: string | undefined;
    const spawnDeadline = Date.now() + 2000;
    while (!projectileId && Date.now() < spawnDeadline) {
      projectileId = [...shard.entities.values()].find((e) => e.kind === 'projectile')?.id;
      if (!projectileId) await new Promise((r) => setTimeout(r, 20));
    }
    expect(projectileId).toBeDefined();

    // …and C sees the whole flight in order: fired → impact → hit (25).
    const fired = await c.client.next(isKind('missile-fired'), 'missile-fired event', 5000);
    expect(fired.payload).toMatchObject({
      kind: 'missile-fired',
      source: { kind: 'player', id: a.playerId },
      weapon: 'missile',
      projectile: projectileId,
    });
    const impact = await c.client.next(isKind('missile-impact'), 'missile-impact event', 5000);
    expect(impact.payload).toMatchObject({
      kind: 'missile-impact',
      weapon: 'missile',
      projectile: projectileId,
    });
    const hit = await c.client.next(isKind('hit'), 'missile hit event', 5000);
    expect(hit.payload).toEqual({
      kind: 'hit',
      target: b.shipId,
      source: { kind: 'player', id: a.playerId },
      weapon: 'missile',
      damage: 25,
      shieldHit: 25,
      hullHit: 0,
    });

    // B's shields drop to 1 − 25/50; the projectile is GONE after impact.
    await waitForShields(b.shipId, 1 - 25 / 50);
    const goneDeadline = Date.now() + 5000;
    while (
      [...shard.entities.values()].some((e) => e.kind === 'projectile') &&
      Date.now() < goneDeadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect([...shard.entities.values()].some((e) => e.kind === 'projectile')).toBe(false);

    // A paid the 10-u missile cost (90 plus a little regen, never undefined).
    expect(eA.energy).toBeGreaterThan(89.5);
    expect(eA.energy).toBeLessThanOrEqual(100);

    a.client.close();
    b.client.close();
    c.client.close();
  }, 20000);

  it('denied fire: a scout missile intent is a silent drop — no combat_event reaches C, no energy spent', async () => {
    const a = await join('Wpn-Alpha-3');
    const b = await join('Wpn-Bravo-3');
    const c = await join('Wpn-Charlie-3');
    await parkInSpace(
      a.playerId,
      b.playerId,
      { x: 80000, y: 80000, z: 0 },
      { x: 80060, y: 80000, z: 0 },
    );
    const eA = shard.entities.get(a.shipId)!;
    expect(eA.classId).toBe('scout');
    expect(eA.energy).toBe(100); // docked at the pad → first tick materialized the cap

    // A's valid in-range target, but a scout CANNOT carry missiles (loadout
    // gate over the wire) — and a targetless missile is denied too.
    const before = eA.energy!;
    a.client.send({
      v: PROTOCOL_VERSION,
      type: 'fire',
      payload: { weapon: 'missile', targetId: b.shipId },
    });
    a.client.send({ v: PROTOCOL_VERSION, type: 'fire', payload: { weapon: 'missile' } });

    // Silent drop: NO combat_event reaches the observer…
    let sawEvent = false;
    try {
      await c.client.next(isCombat, 'combat_event after a denied fire', 400);
      sawEvent = true;
    } catch {
      /* expected: the denied fire emits nothing */
    }
    expect(sawEvent).toBe(false);
    expect([...shard.entities.values()].some((e) => e.kind === 'projectile')).toBe(false);

    // …and A spent NOTHING (denied fires refund — here nothing was ever
    // committed; a few regen ticks can only hold the cap, never spend).
    await new Promise((r) => setTimeout(r, 150));
    expect(eA.energy).toBeGreaterThanOrEqual(before);
    expect(eA.energy).toBeLessThanOrEqual(100);
    // B never took damage.
    expect(shard.entities.get(b.shipId)!.shields).toBe(1);

    a.client.close();
    b.client.close();
    c.client.close();
  }, 20000);
});
