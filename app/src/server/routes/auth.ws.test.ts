import { AddressInfo } from 'node:net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { createDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { createTokenCodec } from '@server/auth/token';
import { createSessionService, createTokenAuthenticate } from '@server/auth/session';
import { registerApiRoutes } from '@server/routes';
import { attachWebSocket, type WebSocketHandle } from '@server/ws';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'ws-test-secret',
  GALAXY_SEED: 'drift-dev-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
};

let dir: string;
let app: FastifyInstance;
let repo: ReturnType<typeof createRepo>;
let handle: WebSocketHandle;
let wsUrl: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-authws-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'test.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('ws-test-secret') });
  app = buildServer(env);
  registerApiRoutes(app, { repo, sessions, galaxySeed: env.GALAXY_SEED });
  handle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: {
      async enterSystem(systemId) {
        if (!(await repo.findSystem(systemId))) {
          return { ok: false, code: 'system-not-found', message: 'not registered' };
        }
        return { ok: true, snapshot: { systemId, entities: [], nodes: [], chat: [], players: [] } };
      },
    },
    authenticate: createTokenAuthenticate(sessions),
    keepalive: { pingIntervalMs: 60_000, dropAfterMs: 180_000 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  wsUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
});

afterAll(async () => {
  await handle.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

class Client {
  readonly ws: WebSocket;
  private queue: Envelope[] = [];
  private waiters: Array<() => void> = [];
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => undefined); // teardown noise is tolerated
    this.ws.on('message', (data) => {
      this.queue.push(JSON.parse(String(data)) as Envelope);
      for (const w of this.waiters.splice(0)) w();
    });
    this.ws.on('close', () => (this.closed = true));
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', resolve);
      this.ws.once('close', () => reject(new Error('closed before open')));
    });
  }

  send(envelope: Envelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  hello(): void {
    this.send({ v: 1, type: 'hello', payload: { v: 1 } });
  }

  auth(token: string): void {
    this.send({ v: 1, type: 'auth', payload: { token } });
  }

  /** Consume the first queued message matching the predicate. */
  async next(predicate: (m: Envelope) => boolean, what: string, ms = 2000): Promise<Envelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.queue.findIndex(predicate);
      if (idx !== -1) return this.queue.splice(idx, 1)[0];
      if (this.closed || Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what} (got: ${this.queue.map((m) => m.type).join(',')})`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }

  error(): Promise<Envelope> {
    return this.next((m) => m.type === 'error', 'error');
  }

  close(): void {
    this.ws.close();
  }
}

async function claim(callsign: string): Promise<{ token: string; homeSystemId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/callsigns',
    payload: { callsign },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('WS auth with session tokens (TASK-10)', () => {
  it('hello → auth{token} → join_system enters the home system', async () => {
    const { token, homeSystemId } = await claim('ws-alfa');
    await repo.upsertSystem(homeSystemId, 'Home');
    const client = new Client(wsUrl);
    await client.open();
    client.hello();
    client.auth(token);
    client.send({ v: 1, type: 'join_system', payload: { systemId: homeSystemId } });
    const enter = await client.next((m) => m.type === 'enter_system', 'enter_system');
    expect(enter.payload).toMatchObject({ snapshot: { systemId: homeSystemId } });
    client.close();
  });

  it('rejects gameplay sent before authentication with unauthenticated', async () => {
    const client = new Client(wsUrl);
    await client.open();
    client.send({ v: 1, type: 'join_system', payload: { systemId: 'abc' } });
    const err = await client.error();
    expect(err.payload).toMatchObject({ code: 'unauthenticated' });
    client.hello();
    client.send({
      v: 1,
      type: 'input',
      payload: { seq: 0, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
    });
    const err2 = await client.error();
    expect(err2.payload).toMatchObject({ code: 'unauthenticated' });
    client.close();
  });

  it('rejects a garbage token, then admits the same connection with a valid one', async () => {
    const { token, homeSystemId } = await claim('ws-bravo');
    await repo.upsertSystem(homeSystemId, 'Home');
    const client = new Client(wsUrl);
    await client.open();
    client.hello();
    client.auth('definitely.not-a-valid-token');
    const err = await client.error();
    expect(err.payload).toMatchObject({ code: 'unauthenticated' });
    client.auth(token);
    client.send({ v: 1, type: 'join_system', payload: { systemId: homeSystemId } });
    const enter = await client.next((m) => m.type === 'enter_system', 'enter_system');
    expect(enter.payload).toMatchObject({ snapshot: { systemId: homeSystemId } });
    client.close();
  });

  it('rejects callsign-only auth (claims are a REST operation, not a handshake)', async () => {
    const client = new Client(wsUrl);
    await client.open();
    client.hello();
    client.send({ v: 1, type: 'auth', payload: { callsign: 'ws-charlie' } });
    const err = await client.error();
    expect(err.payload).toMatchObject({ code: 'unauthenticated' });
    const player = await repo.findPlayerByCallsign('ws-charlie');
    expect(player).toBeUndefined();
    client.close();
  });

  it('rejects a token from a different secret (invalid signature)', async () => {
    const { homeSystemId } = await claim('ws-yankee');
    await repo.upsertSystem(homeSystemId, 'Home');
    const other = createTokenCodec('not-the-server-secret');
    const forged = other.sign({
      playerId: (await repo.findPlayerByCallsign('ws-yankee'))!.id,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const client = new Client(wsUrl);
    await client.open();
    client.hello();
    client.auth(forged);
    const err = await client.error();
    expect(err.payload).toMatchObject({ code: 'unauthenticated', message: 'invalid-signature' });
    client.close();
  });
});
