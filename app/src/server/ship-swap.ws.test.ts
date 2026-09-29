import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
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
import { PROTOCOL_VERSION } from '@shared/protocol';
import type { EntityState } from '@shared/protocol/schemas';
import { homeDockPosition } from '@shared/galaxy/dock';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'swap-test-secret',
  GALAXY_SEED: 'drift-dev-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
};

const GALAXY_SEED = env.GALAXY_SEED;
const OTHER_SYSTEM = 'f'.repeat(16);

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

class TestClient {
  readonly ws: WebSocket;
  readonly messages: Envelope[] = [];
  closed = false;
  private wake: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {
      // Tolerated: teardown terminates sockets the client no longer uses.
    });
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as Envelope);
      for (const w of this.wake.splice(0)) w();
    });
    this.ws.on('close', () => {
      this.closed = true;
      for (const w of this.wake.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', () => reject(new Error('socket closed before open')));
    });
  }

  send(envelope: Envelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  /** Consume the first unmatched message matching the predicate. */
  async next(predicate: (m: Envelope) => boolean, what: string, ms = 3000): Promise<Envelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.messages.findIndex(predicate);
      if (idx !== -1) return this.messages.splice(idx, 1)[0];
      if (this.closed || Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what} (closed=${this.closed}, got: ${this.messages
            .map((m) => m.type)
            .join(',')})`,
        );
      }
      await new Promise<void>((resolve) => {
        this.wake.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

async function join(client: TestClient, token: string, systemId: string): Promise<void> {
  await client.open();
  client.send({ v: PROTOCOL_VERSION, type: 'hello', payload: { v: PROTOCOL_VERSION } });
  client.send({ v: PROTOCOL_VERSION, type: 'auth', payload: { token } });
  client.send({ v: PROTOCOL_VERSION, type: 'join_system', payload: { systemId } });
  await client.next((m) => m.type === 'enter_system', 'enter_system');
}

let dir: string;
let app: FastifyInstance;
let repo: Repository;
let httpUrl: string;
let wsUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-swap-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'swap.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({
    repo,
    codec: createTokenCodec('swap-test-secret'),
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

describe('ship-swap broadcast (TASK-20, ws integration)', () => {
  it('replaces the ship entity in place and broadcasts entity_update to in-system peers', async () => {
    const p = await claim('Swap-1');
    await repo.upsertSystem(p.homeSystemId, 'Home');
    await repo.upsertSystem(OTHER_SYSTEM, 'Elsewhere');
    await repo.addCredits(p.playerId, 10_000);

    const inSystem = new TestClient(wsUrl);
    const elsewhere = new TestClient(wsUrl);
    await join(inSystem, p.token, p.homeSystemId);
    // A second player's connection in another system must not see the swap.
    const other = await claim('Bystander-1');
    await join(elsewhere, other.token, OTHER_SYSTEM);

    const buyRes = await fetch(`${httpUrl}/api/ships/buy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
      body: JSON.stringify({ classId: 'freighter' }),
    });
    expect(buyRes.status).toBe(201);
    const bought = (await buyRes.json()) as { ship: { id: string } };

    const msg = await inSystem.next((m) => m.type === 'entity_update', 'entity_update');
    const entities = (msg.payload as { entities: EntityState[] }).entities;
    expect(entities.length).toBe(1);
    const e = entities[0];
    // Replaced in place: the scrubbed ship's id keeps its slot, new class stats.
    expect(e.id).toBe(p.shipId);
    expect(e.kind).toBe('ship');
    expect(e.classId).toBe('freighter');
    expect(e.regime).toBe('docked');
    expect(e.hull).toBe(1);
    expect(e.shields).toBe(1);
    expect(e.callsign).toBe('swap-1');
    expect(e.pos).toEqual(homeDockPosition(GALAXY_SEED, p.homeSystemId));
    expect(bought.ship.id).not.toBe(p.shipId); // persisted row is a new ship

    // A second swap keeps the same entity id (still in-place for the shard).
    const buy2 = await fetch(`${httpUrl}/api/ships/buy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
      body: JSON.stringify({ classId: 'interceptor' }),
    });
    expect(buy2.status).toBe(201);
    const msg2 = await inSystem.next((m) => m.type === 'entity_update', 'entity_update');
    const e2 = (msg2.payload as { entities: EntityState[] }).entities[0];
    expect(e2.id).toBe(p.shipId);
    expect(e2.classId).toBe('interceptor');

    // No swap traffic reached the other system.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(elsewhere.messages.some((m) => m.type === 'entity_update')).toBe(false);

    inSystem.close();
    elsewhere.close();
  });

  it('does not broadcast when the player is not in-system', async () => {
    const p = await claim('Alone-1');
    await repo.upsertSystem(p.homeSystemId, 'Home');
    await repo.addCredits(p.playerId, 10_000);

    // Nobody is in the player's system: the emit is a no-op and the buy
    // still succeeds (REST does not depend on shard liveness).
    const buyRes = await fetch(`${httpUrl}/api/ships/buy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
      body: JSON.stringify({ classId: 'interceptor' }),
    });
    expect(buyRes.status).toBe(201);
    const ship = await repo.getShipByOwner(p.playerId);
    expect(ship?.classId).toBe('interceptor');
    expect(ship?.state).toBe('docked');
  });
});
