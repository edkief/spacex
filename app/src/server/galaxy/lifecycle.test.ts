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
import { createGalaxyRouter } from './router';
import { createRouterGateway } from './gateway';
import { WsTestClient } from '@server/ws-test-client';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { PROTOCOL_VERSION } from '@shared/protocol';
import type { StateSnapshot } from '@shared/protocol/schemas';

/**
 * TASK-12 shard lifecycle over live ws (real server wiring):
 * the join handshake answers with the full initial snapshot in ONE
 * round-trip (enter_system), every existing peer receives a presence
 * 'join', a disconnect triggers presence 'leave', and the leaving
 * player's ship STAYS in the shard (abandoned ships are not reaped).
 */

const GALAXY_SEED = 'lifecycle-ws-seed-001';
const firstStar = generateStars(GALAXY_SEED)[0];
const SYSTEM_ID = generateSystem(GALAXY_SEED, firstStar.id).systemId;

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'lifecycle-ws-secret',
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
let httpUrl: string;
let wsUrl: string;
let closeServer: () => Promise<void>;
const clients: WsTestClient[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-lifecycle-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'lifecycle.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('lifecycle-ws-secret') });
  const bus = createShipSwapBus();
  router = createGalaxyRouter({ repo, galaxySeed: GALAXY_SEED, shipSwapBus: bus });

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
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}${env.WS_PATH}`;
  closeServer = async () => {
    for (const c of clients.splice(0)) c.close();
    await router.stopAll();
    await app.close();
  };
});

afterAll(async () => {
  await closeServer();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function claim(
  callsign: string,
): Promise<{ token: string; shipId: string; callsign: string }> {
  const res = await fetch(`${httpUrl}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; shipId: string; callsign: string };
}

function mkClient(): WsTestClient {
  const c = new WsTestClient(wsUrl);
  clients.push(c);
  return c;
}

/** Handshake + join, returning the initial full snapshot (one round-trip). */
async function join(client: WsTestClient, token: string, systemId: string): Promise<StateSnapshot> {
  await client.open();
  client.send({ v: PROTOCOL_VERSION, type: 'hello', payload: { v: PROTOCOL_VERSION } });
  client.send({ v: PROTOCOL_VERSION, type: 'auth', payload: { token } });
  client.send({ v: PROTOCOL_VERSION, type: 'join_system', payload: { systemId } });
  const enter = await client.next((m) => m.type === 'enter_system', 'enter_system', 8000);
  return (enter.payload as { snapshot: StateSnapshot }).snapshot;
}

describe('shard lifecycle over live ws (TASK-12)', () => {
  it('join answers with a full snapshot; peers see presence join; leave keeps the ship in the shard', async () => {
    const a = await claim('Life-A');
    const b = await claim('Life-B');

    const ca = mkClient();
    const snapA = await join(ca, a.token, SYSTEM_ID);
    expect(snapA.systemId).toBe(SYSTEM_ID);
    expect(snapA.entities.some((e) => e.id === a.shipId)).toBe(true);

    // B joins while A is in-system: one round-trip (hello → auth →
    // join_system) delivers B the FULL snapshot — own ship, A's ship and
    // A's callsign — in a single enter_system message.
    const cb = mkClient();
    const snapB = await join(cb, b.token, SYSTEM_ID);
    expect(snapB.systemId).toBe(SYSTEM_ID);
    expect(snapB.entities.some((e) => e.id === b.shipId)).toBe(true);
    expect(snapB.entities.some((e) => e.id === a.shipId)).toBe(true);
    expect(snapB.players).toHaveLength(1);
    expect(snapB.players[0].callsign).toBe(a.callsign);

    // A, the existing peer, was told B joined (TASK-15 consumes this).
    const pjoin = await ca.next((m) => m.type === 'presence', 'presence join', 8000);
    expect(pjoin.payload).toMatchObject({
      event: 'join',
      player: { playerId: expect.any(String), callsign: b.callsign },
    });

    // B disconnects → A is told B left…
    cb.close();
    const pleave = await ca.next(
      (m) => m.type === 'presence' && (m.payload as { event: string }).event === 'leave',
      'presence leave',
      8000,
    );
    expect(pleave.payload).toMatchObject({ event: 'leave', player: { callsign: b.callsign } });
    expect(router.active(SYSTEM_ID)!.shard.connections.size).toBe(1);

    // …but B's ship is NOT removed: abandoned ships stay in the shard
    // (idle, dockable again) — A's next 10 Hz snapshot still carries it.
    const upd = await ca.next((m) => m.type === 'entity_update', 'entity_update', 8000);
    const entities = (upd.payload as { entities: Array<{ id: string }> }).entities;
    expect(entities.some((e) => e.id === b.shipId)).toBe(true);
  }, 20000);

  it('rejoining the same system within the grace reuses the live shard', async () => {
    const p = await claim('Life-Rejoin');
    const c = mkClient();
    const snap = await join(c, p.token, SYSTEM_ID);
    const first = router.active(SYSTEM_ID)!;
    expect(snap.systemId).toBe(SYSTEM_ID);
    expect(first.shard.connections.size).toBeGreaterThanOrEqual(1);

    // Disconnect, then immediately rejoin — the 60 s reap grace is far
    // from elapsed, so the SAME shard (same generation) serves the return.
    c.close();
    await new Promise((r) => setTimeout(r, 100));
    const c2 = mkClient();
    const again = await join(c2, p.token, SYSTEM_ID);
    expect(again.systemId).toBe(SYSTEM_ID);
    const second = router.active(SYSTEM_ID)!;
    expect(second).toBe(first);
    expect(second.generation).toBe(first.generation);
  }, 20000);
});
