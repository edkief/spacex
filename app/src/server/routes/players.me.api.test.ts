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
  PORT: 3001,
  SESSION_SECRET: 'players-me-test-secret',
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
let codec: ReturnType<typeof createTokenCodec>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-players-me-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'test.db') });
  repo = createRepo(db, sqliteTables);
  codec = createTokenCodec(env.SESSION_SECRET);
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
  return res.json() as { callsign: string; token: string; playerId: string; homeSystemId: string };
}

function me(token: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: '/api/players/me',
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

describe('GET /api/players/me (TASK-41)', () => {
  it('returns the caller profile with the 500-credit start balance', async () => {
    const { token, playerId, homeSystemId } = await claim('Sierra-1');
    const res = await me(token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.callsign).toBe('sierra-1');
    expect(body.credits).toBe(500);
    expect(body.homeSystemId).toBe(homeSystemId);
    expect(body.shipId).toMatch(/^[0-9a-f-]{36}$/);
    // shipId belongs to the caller
    const ship = (await repo.listShipsInSystem(homeSystemId)).find((s) => s.id === body.shipId);
    expect(ship?.ownerId).toBe(playerId);
  });

  it('reflects credit changes made through the repository', async () => {
    const { token, playerId } = await claim('Tango-2');
    await repo.addCredits(playerId, 300);
    await repo.withdrawCredits(playerId, 100);
    expect((await me(token)).json().credits).toBe(700);
  });

  it('returns 401 with a structured error when the bearer token is missing or forged', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/players/me' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ code: 'unauthenticated', reason: 'missing bearer token' });

    const otherCodec = createTokenCodec('a-different-secret');
    const { playerId } = await claim('Uniform-3');
    const forged = otherCodec.sign({ playerId, exp: Math.floor(Date.now() / 1000) + 3600 });
    const res = await app.inject({
      method: 'GET',
      url: '/api/players/me',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'invalid-signature' });
    expect(res.body).not.toContain(forged);
  });

  it('exposes no endpoint for other players in v1: foreign ids are 404', async () => {
    const { playerId } = await claim('Victor-4');
    const res = await app.inject({ method: 'GET', url: `/api/players/${playerId}` });
    expect(res.statusCode).toBe(404);
  });
});
