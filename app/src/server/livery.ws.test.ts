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
import { attachShipSwapBroadcast, createShipSwapBus } from '@server/shards';
import { attachWebSocket, createRegistryGateway } from '@server/ws';
import { WsTestClient, joinSystem } from '@server/ws-test-client';
import type { EntityState } from '@shared/protocol/schemas';
import { SHIP_CLASSES } from '@shared/ships';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'livery-ws-secret',
  GALAXY_SEED: 'drift-dev-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
};

const GALAXY_SEED = env.GALAXY_SEED;
const OTHER_SYSTEM = 'e'.repeat(16);

let dir: string;
let app: FastifyInstance;
let repo: Repository;
let httpUrl: string;
let wsUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-livery-ws-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'livery.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({
    repo,
    codec: createTokenCodec('livery-ws-secret'),
  });
  const bus = createShipSwapBus();
  app = buildServer(env);
  registerApiRoutes(app, { repo, sessions, galaxySeed: GALAXY_SEED, shipSwapBus: bus });
  const handle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: createRegistryGateway(repo),
    authenticate: createTokenAuthenticate(sessions),
  });
  attachShipSwapBroadcast(bus, handle.connections, repo);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}${env.WS_PATH}`;
  closeServer = async () => {
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
): Promise<{ token: string; playerId: string; homeSystemId: string; shipId: string }> {
  const res = await fetch(`${httpUrl}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    token: string;
    playerId: string;
    homeSystemId: string;
    shipId: string;
  };
}

async function setLivery(token: string, colors: Record<string, string>) {
  const res = await fetch(`${httpUrl}/api/ships/livery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ colors }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('livery broadcast (TASK-21, ws integration)', () => {
  it('broadcasts entity_update with the new livery to in-system peers', async () => {
    const p = await claim('Paint-1');
    await repo.upsertSystem(p.homeSystemId, 'Home');
    await repo.upsertSystem(OTHER_SYSTEM, 'Elsewhere');

    const inSystem = new WsTestClient(wsUrl);
    const elsewhere = new WsTestClient(wsUrl);
    await joinSystem(inSystem, p.token, p.homeSystemId);
    const other = await claim('Paint-Bystander');
    await joinSystem(elsewhere, other.token, OTHER_SYSTEM);

    const colors = { hull: '#aa0000', accent: '#00aa00', trim: '#0000aa' };
    const res = await setLivery(p.token, colors);
    expect(res.status).toBe(200);

    const msg = await inSystem.next((m) => m.type === 'entity_update', 'entity_update');
    const entities = (msg.payload as { entities: EntityState[] }).entities;
    expect(entities.length).toBe(1);
    const e = entities[0];
    expect(e.id).toBe(p.shipId); // no swap happened: the ship id is the entity id
    expect(e.kind).toBe('ship');
    expect(e.classId).toBe('scout');
    expect(e.livery).toEqual(colors);
    expect(e.callsign).toBe('paint-1');

    // The update landed in the database too.
    expect((await repo.getShipByOwner(p.playerId))?.livery).toEqual(colors);

    // No livery traffic reached the other system.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(elsewhere.messages.some((m) => m.type === 'entity_update')).toBe(false);

    inSystem.close();
    elsewhere.close();
  });

  it('targets the swapped entity id and shows class defaults until painted', async () => {
    const p = await claim('Paint-2');
    await repo.upsertSystem(p.homeSystemId, 'Home');
    await repo.addCredits(p.playerId, 10_000);

    const inSystem = new WsTestClient(wsUrl);
    await joinSystem(inSystem, p.token, p.homeSystemId);

    // Buy first: the entity keeps the original ship's id in-system.
    const buyRes = await fetch(`${httpUrl}/api/ships/buy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
      body: JSON.stringify({ classId: 'interceptor' }),
    });
    expect(buyRes.status).toBe(201);
    const bought = (await buyRes.json()) as {
      ship: { id: string; livery: Record<string, string> };
    };
    const swapMsg = await inSystem.next((m) => m.type === 'entity_update', 'swap entity_update');
    expect((swapMsg.payload as { entities: EntityState[] }).entities[0].id).toBe(p.shipId);
    // The new ship carries its catalog default livery on the wire.
    expect((swapMsg.payload as { entities: EntityState[] }).entities[0].livery).toEqual(
      SHIP_CLASSES.interceptor.defaultLivery,
    );

    const colors = { hull: '#010203', accent: '#040506', trim: '#070809' };
    const res = await setLivery(p.token, colors);
    expect(res.status).toBe(200);

    const msg = await inSystem.next((m) => m.type === 'entity_update', 'livery entity_update');
    const e = (msg.payload as { entities: EntityState[] }).entities[0];
    expect(e.id).toBe(p.shipId); // still the pre-swap id the clients hold
    expect(e.classId).toBe('interceptor');
    expect(e.livery).toEqual(colors);
    expect(bought.ship.id).not.toBe(p.shipId);

    inSystem.close();
  });

  it('is a no-op for a player whose system has no active peers', async () => {
    const p = await claim('Paint-3');
    await repo.upsertSystem(p.homeSystemId, 'Home');
    const res = await setLivery(p.token, { hull: '#121212', accent: '#343434', trim: '#565656' });
    expect(res.status).toBe(200);
    expect((await repo.getShipByOwner(p.playerId))?.livery).toEqual({
      hull: '#121212',
      accent: '#343434',
      trim: '#565656',
    });
  });
});
