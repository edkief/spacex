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
  SHARD_FLUSH_INTERVAL_MS: 30000,
};

let dir: string;
let app: FastifyInstance;
let repo: ReturnType<typeof createRepo>;
let sessions: ReturnType<typeof createSessionService>;
let handle: WebSocketHandle;
let wsUrl: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-authws-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'test.db') });
  repo = createRepo(db, sqliteTables);
  sessions = createSessionService({ repo, codec: createTokenCodec('ws-test-secret') });
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
    revokeToken: (token) => sessions.revoke(token),
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
  closeCode: number | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => undefined); // teardown noise is tolerated
    this.ws.on('message', (data) => {
      this.queue.push(JSON.parse(String(data)) as Envelope);
      for (const w of this.waiters.splice(0)) w();
    });
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
    });
  }

  /** Resolve with the close code once the server closes the socket. */
  waitClose(ms = 2000): Promise<number> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const check = (): void => {
        if (this.closeCode !== null) return resolve(this.closeCode);
        if (Date.now() > deadline) {
          return reject(new Error(`timed out waiting for close (code so far: ${this.closeCode})`));
        }
        setTimeout(check, 10);
      };
      check();
    });
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

describe('WS logout + revocation (TASK-66)', () => {
  it('logout revokes the presenting token and closes with code 1000', async () => {
    const { token, homeSystemId } = await claim('ws-logout-1');
    await repo.upsertSystem(homeSystemId, 'Home');
    const client = new Client(wsUrl);
    await client.open();
    client.hello();
    client.auth(token);
    client.send({ v: 1, type: 'join_system', payload: { systemId: homeSystemId } });
    await client.next((m) => m.type === 'enter_system', 'enter_system');
    client.send({ v: 1, type: 'logout', payload: {} });
    expect(await client.waitClose()).toBe(1000);

    // The token is revoked: REST use is a 401...
    const res = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'unknown-session' });

    // ...and a fresh WS handshake with it is rejected.
    const other = new Client(wsUrl);
    await other.open();
    other.hello();
    other.auth(token);
    const err = await other.error();
    expect(err.payload).toMatchObject({ code: 'unauthenticated', message: 'unknown-session' });
    other.close();
  });

  it('logout before auth is rejected with unauthenticated', async () => {
    const client = new Client(wsUrl);
    await client.open();
    client.send({ v: 1, type: 'logout', payload: {} });
    const err = await client.error();
    expect(err.payload).toMatchObject({ code: 'unauthenticated' });
    client.close();
  });

  it('shared account model: the same token backs two connections until revocation', async () => {
    const { token, homeSystemId } = await claim('ws-shared-1');
    await repo.upsertSystem(homeSystemId, 'Home');
    const a = new Client(wsUrl);
    const b = new Client(wsUrl);
    await a.open();
    await b.open();
    for (const c of [a, b]) {
      c.hello();
      c.auth(token); // same token on both connections — both admitted
      c.send({ v: 1, type: 'join_system', payload: { systemId: homeSystemId } });
    }
    await a.next((m) => m.type === 'enter_system', 'a enters');
    await b.next((m) => m.type === 'enter_system', 'b enters');

    // Revocation through one connection's logout...
    a.send({ v: 1, type: 'logout', payload: {} });
    expect(await a.waitClose()).toBe(1000);

    // ...does not kick the other already-authenticated connection (the token
    // is only re-checked at handshake)...
    expect(b.closed).toBe(false);

    // ...but every new use of the token fails.
    const c = new Client(wsUrl);
    await c.open();
    c.hello();
    c.auth(token);
    const err = await c.error();
    expect(err.payload).toMatchObject({ code: 'unauthenticated', message: 'unknown-session' });
    c.close();
    b.close();
  });
});
