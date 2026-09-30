import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
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

/**
 * Log-leak regression guard (TASK-66, stays in CI): run the full
 * claim → session → logout cycle against a pino instance whose stream is a
 * capture sink, then scan every captured line for the SESSION_SECRET value,
 * the issued tokens and their sha256 hashes. Any match fails the test.
 */

const SECRET = 'task66-log-leak-secret-do-not-log';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: SECRET,
  GALAXY_SEED: 'drift-dev-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
  SHARD_FLUSH_INTERVAL_MS: 30000,
};

const logLines: string[] = [];
/** pino sink that records every serialized line instead of writing a fd. */
const capture = {
  write: (line: string): void => {
    logLines.push(line);
  },
};

let dir: string;
let app: FastifyInstance;
let handle: WebSocketHandle;
let wsUrl: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-logleak-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'test.db') });
  const repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec(SECRET) });
  app = buildServer(env, { loggerInstance: pino({ level: 'trace' }, capture) });
  registerApiRoutes(app, { repo, sessions, galaxySeed: env.GALAXY_SEED });
  handle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: {
      async enterSystem(systemId) {
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

async function claim(callsign: string): Promise<{ token: string; homeSystemId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/callsigns',
    payload: { callsign },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function sessionOf(token: string) {
  return app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Minimal WS client: handshakes, then logs out and reports the close code. */
async function wsLogout(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error('ws logout timed out')), 3000);
    ws.on('error', () => undefined);
    ws.on('open', () => {
      ws.send(JSON.stringify({ v: 1, type: 'hello', payload: { v: 1 } }));
      ws.send(JSON.stringify({ v: 1, type: 'auth', payload: { token } }));
      ws.send(JSON.stringify({ v: 1, type: 'logout', payload: {} }));
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const sha256hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

describe('session token log-leak guard (TASK-66)', () => {
  it('claim → session → logout (REST + WS) leaks no secret, token or hash into the logs', async () => {
    // Token A: REST session use, then revoked through a WS logout.
    const { token: tokenA } = await claim('leak-alfa');
    expect((await sessionOf(tokenA)).statusCode).toBe(200);
    expect(await wsLogout(tokenA)).toBe(1000);
    expect((await sessionOf(tokenA)).statusCode).toBe(401);

    // Token B: revoked through the REST logout endpoint.
    const { token: tokenB } = await claim('leak-bravo');
    const logoutB = await app.inject({
      method: 'POST',
      url: '/api/session/logout',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(logoutB.statusCode).toBe(200);
    expect((await sessionOf(tokenB)).statusCode).toBe(401);

    // The sink must have actually captured output, or this test proves
    // nothing: fastify logs at least the listen announcement.
    expect(logLines.length).toBeGreaterThan(0);

    const all = logLines.join('\n');
    const suspects: Array<[label: string, value: string]> = [
      ['SESSION_SECRET', SECRET],
      ['issued token A', tokenA],
      ['issued token B', tokenB],
      ['sha256 of token A', sha256hex(tokenA)],
      ['sha256 of token B', sha256hex(tokenB)],
    ];
    const leaked = suspects.filter(([, value]) => all.includes(value));
    expect(leaked, `logs leaked: ${leaked.map(([label]) => label).join(', ')}`).toEqual([]);
  });
});
