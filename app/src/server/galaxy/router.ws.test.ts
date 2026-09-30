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
import { attachWebSocket } from '@server/ws';
import { createGalaxyRouter, SHARD_LOAD_BUDGET_MS } from './router';
import { createRouterGateway } from './gateway';
import { WsTestClient } from '@server/ws-test-client';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { homeSystemIdForPlayer } from '@shared/galaxy/home';
import { MAX_PLAYERS_PER_SYSTEM, PROTOCOL_VERSION } from '@shared/protocol';
import type { StateSnapshot } from '@shared/protocol/schemas';

/**
 * TASK-11 live-ws tests over the real server wiring (index.ts equivalent):
 * 10 clients joining 3 different systems in parallel (distinct shard state,
 * no cross-system bleed, load under budget), the 16-player cap (a rejected
 * joiner stays in their previous system), GET /api/galaxy/health, and
 * system-not-found for unknown ids.
 */

const GALAXY_SEED = 'router-ws-seed-001';
const stars = generateStars(GALAXY_SEED);
/** System ids (hash of seed+starId — NOT the star ids) for the first stars. */
const systemIds = stars.slice(0, 6).map((s) => generateSystem(GALAXY_SEED, s.id).systemId);
const allSystemIds = new Set(
  generateStars(GALAXY_SEED).map((s) => generateSystem(GALAXY_SEED, s.id).systemId),
);

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'router-ws-secret',
  GALAXY_SEED,
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
  SHARD_FLUSH_INTERVAL_MS: 30_000,
};

let dir: string;
let app: FastifyInstance;
let repo: Repository;
let router: ReturnType<typeof createGalaxyRouter>;
let stopReaper: () => void;
let httpUrl: string;
let wsUrl: string;
let closeServer: () => Promise<void>;
const clients: WsTestClient[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-router-ws-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'router-ws.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('router-ws-secret') });
  const bus = createShipSwapBus();
  router = createGalaxyRouter({ repo, galaxySeed: GALAXY_SEED, shipSwapBus: bus });
  stopReaper = router.startReaper();

  app = buildServer(env);
  registerApiRoutes(app, {
    repo,
    sessions,
    galaxySeed: GALAXY_SEED,
    shipSwapBus: bus,
    galaxyRouter: router,
  });
  attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: createRouterGateway(router),
    authenticate: createTokenAuthenticate(sessions),
    onGameMessage: (conn, type, payload) => {
      if (type === 'input' && conn.systemId && conn.playerId) {
        router.active(conn.systemId)?.shard.enqueueInput(conn.playerId, payload as never);
      }
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}${env.WS_PATH}`;
  closeServer = async () => {
    stopReaper();
    await router.stopAll();
    for (const c of clients.splice(0)) c.close();
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
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; playerId: string; shipId: string };
}

function mkClient(): WsTestClient {
  const c = new WsTestClient(wsUrl);
  clients.push(c);
  return c;
}

/** Handshake + join, returning the initial full snapshot. */
async function join(client: WsTestClient, token: string, systemId: string): Promise<StateSnapshot> {
  await client.open();
  client.send({ v: PROTOCOL_VERSION, type: 'hello', payload: { v: PROTOCOL_VERSION } });
  client.send({ v: PROTOCOL_VERSION, type: 'auth', payload: { token } });
  client.send({ v: PROTOCOL_VERSION, type: 'join_system', payload: { systemId } });
  const enter = await client.next((m) => m.type === 'enter_system', 'enter_system', 8000);
  return (enter.payload as { snapshot: StateSnapshot }).snapshot;
}

describe('galaxy router over live ws (TASK-11)', () => {
  it('10 clients joining 3 systems in parallel get distinct, correct shard state', async () => {
    const ids = [systemIds[0], systemIds[1], systemIds[2]];
    const players: Array<{ token: string; playerId: string; shipId: string }> = [];
    for (let i = 0; i < 10; i++) {
      players.push(await claim(`Swarm-${i}`));
    }
    // All 10 joins at once: three shards spawn concurrently, loads collapse.
    const snapshots = await Promise.all(
      players.map((p, i) => join(mkClient(), p.token, ids[i % 3])),
    );

    // Three active shards, each under the 500 ms load budget.
    expect(router.stats()).toHaveLength(3);
    for (const id of ids) {
      expect(router.active(id)).toBeDefined();
      expect(router.active(id)!.loadMs).toBeLessThanOrEqual(SHARD_LOAD_BUDGET_MS);
    }

    // No cross-system bleed: every entity in a snapshot is one of the 10
    // starter ships (ids are globally unique, so a shared id would be the
    // bleed), and it may only be in a sim it legitimately belongs to — the
    // system its owner joined, or the owner's seed-derived home system
    // (starter ships dock there, so a home shard loads them from the DB
    // even while their owner sits in a different system).
    const ownerOfShip = new Map(players.map((p, j) => [p.shipId, j]));
    for (let i = 0; i < 10; i++) {
      const own = ids[i % 3];
      expect(snapshots[i].systemId).toBe(own);
      expect(
        snapshots[i].entities.some((e) => e.id === players[i].shipId),
        `own ship missing from ${own}`,
      ).toBe(true);
      for (const e of snapshots[i].entities) {
        const j = ownerOfShip.get(e.id);
        expect(j, `client in ${own} sees foreign entity ${e.id}`).toBeDefined();
        const home = homeSystemIdForPlayer(GALAXY_SEED, players[j!].playerId);
        const allowed = new Set([ids[j! % 3], home]);
        expect(
          allowed.has(own),
          `entity ${e.id} is in ${own} but belongs to ${ids[j! % 3]}/${home}`,
        ).toBe(true);
      }
      // The players list carries only same-system callsigns.
      for (const entry of snapshots[i].players) {
        const j = players.findIndex((p) => p.playerId === entry.playerId);
        expect(j, `unknown player ${entry.playerId} in snapshot`).not.toBe(-1);
        expect(ids[j % 3], `cross-system player ${entry.callsign} in snapshot`).toBe(own);
      }
    }
  }, 30000);

  it('join into a full (16-player) system returns system-full; the player stays put', async () => {
    const fullSystem = systemIds[3];
    const quietSystem = systemIds[4];

    // Fill the target system to the cap.
    const fullClaimants: Array<{ playerId: string; shipId: string }> = [];
    for (let i = 0; i < MAX_PLAYERS_PER_SYSTEM; i++) {
      const p = await claim(`Full-${i}`);
      fullClaimants.push({ playerId: p.playerId, shipId: p.shipId });
      await join(mkClient(), p.token, fullSystem);
    }
    expect(router.active(fullSystem)!.shard.connections.size).toBe(MAX_PLAYERS_PER_SYSTEM);

    // The 17th player is already sitting in another system.
    const late = await claim('Full-Late');
    const c = mkClient();
    const quiet = await join(c, late.token, quietSystem);
    expect(quiet.systemId).toBe(quietSystem);

    // Join the full system → rejected with system-full…
    c.send({ v: PROTOCOL_VERSION, type: 'join_system', payload: { systemId: fullSystem } });
    const err = await c.next((m) => m.type === 'error', 'system-full error', 8000);
    expect(err.payload).toMatchObject({ code: 'system-full' });
    expect(router.active(fullSystem)!.shard.connections.size).toBe(MAX_PLAYERS_PER_SYSTEM);

    // …and the player is still in their previous system: the quiet shard's
    // 10 Hz snapshots keep arriving on the same socket, with only its
    // single player aboard.
    const upd = await c.next((m) => m.type === 'entity_update', 'still-in-system snapshot', 8000);
    const entities = (upd.payload as { entities: Array<{ id: string }> }).entities;
    expect(entities.some((e) => e.id === late.shipId)).toBe(true);
    // Every entity in the quiet snapshot must be the late player's own ship,
    // or a Full-* claimant's starter ship whose seed-derived home system is
    // the quiet system (those dock there, so the shard loads them from the DB
    // even while their owner sits in the full system).
    const fullByShip = new Map(fullClaimants.map((p) => [p.shipId, p]));
    for (const e of entities) {
      if (e.id === late.shipId) continue;
      const p = fullByShip.get(e.id);
      expect(p, `unknown entity ${e.id} in quiet system`).toBeDefined();
      expect(
        homeSystemIdForPlayer(GALAXY_SEED, p!.playerId),
        `entity ${e.id} in quiet system but owner's home is elsewhere`,
      ).toBe(quietSystem);
    }
    expect(router.active(quietSystem)!.shard.connections.size).toBe(1);
  }, 60000);

  it('GET /api/galaxy/health (auth) lists active shards with players + uptime', async () => {
    const p = await claim('Health-Check');
    const res = await fetch(`${httpUrl}/api/galaxy/health`, {
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shards: Array<{ systemId: string; name: string; players: number; uptimeMs: number }>;
    };
    const bySystem = new Map(body.shards.map((s) => [s.systemId, s]));
    // The filled system reports its 16 players; the quiet one its single one.
    expect(bySystem.get(systemIds[3])?.players).toBe(MAX_PLAYERS_PER_SYSTEM);
    expect(bySystem.get(systemIds[4])?.players).toBe(1);
    expect(bySystem.get(systemIds[3])?.name).toBe(generateSystem(GALAXY_SEED, stars[3].id).name);
    for (const s of body.shards) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(s.uptimeMs)).toBe(true);
      expect(s.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof s.players).toBe('number');
    }
  }, 15000);

  it('GET /api/galaxy/health without a token → structured 401', async () => {
    const res = await fetch(`${httpUrl}/api/galaxy/health`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
  }, 15000);

  it('join_system for an unknown system id → system-not-found', async () => {
    const p = await claim('Nowhere-Drifter');
    let id = '0'.repeat(16);
    while (allSystemIds.has(id)) {
      id = (BigInt(id) + 1n).toString(16).padStart(16, '0');
    }
    const before = router.stats().length;
    const c = mkClient();
    await c.open();
    c.send({ v: PROTOCOL_VERSION, type: 'hello', payload: { v: PROTOCOL_VERSION } });
    c.send({ v: PROTOCOL_VERSION, type: 'auth', payload: { token: p.token } });
    c.send({ v: PROTOCOL_VERSION, type: 'join_system', payload: { systemId: id } });
    const err = await c.next((m) => m.type === 'error', 'system-not-found', 8000);
    expect(err.payload).toMatchObject({ code: 'system-not-found' });
    // No shard was spawned for the unknown id.
    expect(router.stats()).toHaveLength(before);
    expect(router.active(id)).toBeUndefined();
  }, 15000);
});
