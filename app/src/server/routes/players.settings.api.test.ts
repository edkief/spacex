/**
 * TASK-55: GET/PUT /api/players/settings (auth, zod) + the persistence
 * round trip (PUT Low → a new session establish — the /api/session
 * response — restores Low).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { createDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { createTokenCodec } from '@server/auth/token';
import { createSessionService } from '@server/auth/session';
import { registerApiRoutes } from '@server/routes';

const env: Env = {
  PORT: 3002,
  SESSION_SECRET: 'players-settings-test-secret',
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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-players-settings-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'test.db') });
  const repo = createRepo(db, sqliteTables);
  const codec = createTokenCodec(env.SESSION_SECRET);
  const sessions = createSessionService({ repo, codec });
  app = buildServer(env);
  registerApiRoutes(app, { repo, sessions, galaxySeed: env.GALAXY_SEED });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function claim(callsign: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/callsigns',
    payload: { callsign },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

const get = (token: string) =>
  app.inject({
    method: 'GET',
    url: '/api/players/settings',
    headers: { authorization: `Bearer ${token}` },
  });
const put = (token: string, body: unknown) =>
  app.inject({
    method: 'PUT',
    url: '/api/players/settings',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body,
  });

describe('GET /api/players/settings (TASK-55)', () => {
  it('returns the factory defaults for a never-saved player', async () => {
    const token = await claim('Bravo-1');
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ quality: 'high', sensitivity: 1, 'reduced-motion': false });
  });

  it('is 401 without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/players/settings' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'missing bearer token' });
  });
});

describe('PUT /api/players/settings (TASK-55)', () => {
  it('accepts a partial update, merges over the stored row, and returns the full row', async () => {
    const token = await claim('Charlie-2');
    const res = await put(token, { quality: 'low' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ quality: 'low', sensitivity: 1, 'reduced-motion': false });
    // The merge is cumulative: a later partial keeps the earlier field.
    const res2 = await put(token, { 'reduced-motion': true });
    expect(res2.json()).toEqual({ quality: 'low', sensitivity: 1, 'reduced-motion': true });
  });

  it('rejects a bad quality preset with a 400', async () => {
    const token = await claim('Delta-3');
    const res = await put(token, { quality: 'ultra' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid-settings');
    // The bad write never landed.
    expect((await get(token)).json().quality).toBe('high');
  });

  it('rejects a non-numeric sensitivity with a 400, and unknown fields too', async () => {
    const token = await claim('Echo-4');
    expect((await put(token, { sensitivity: 'fast' })).statusCode).toBe(400);
    expect((await put(token, { quality: 'low', bogus: 1 })).statusCode).toBe(400);
  });

  it('clamps an out-of-range sensitivity (never rejects the number)', async () => {
    const token = await claim('Foxtrot-5');
    expect((await put(token, { sensitivity: 5 })).json().sensitivity).toBe(2);
    expect((await put(token, { sensitivity: -1 })).json().sensitivity).toBe(0.5);
  });
});

describe('persistence round trip (TASK-55)', () => {
  it('set Low → a new session establish (/api/session) restores Low', async () => {
    const token = await claim('Golf-6');
    const putRes = await put(token, { quality: 'low', sensitivity: 0.7 });
    expect(putRes.statusCode).toBe(200);
    // The "restart": a fresh session read (new machine / re-login) — the
    // /api/session response carries the persisted row.
    const res = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      quality: 'low',
      sensitivity: 0.7,
      'reduced-motion': false,
    });
    // And the direct GET agrees.
    expect((await get(token)).json()).toEqual({
      quality: 'low',
      sensitivity: 0.7,
      'reduced-motion': false,
    });
  });

  it('a first join (no saved row) gets the defaults on /api/session', async () => {
    const token = await claim('Hotel-7');
    const res = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().settings).toEqual({
      quality: 'high',
      sensitivity: 1,
      'reduced-motion': false,
    });
  });
});
