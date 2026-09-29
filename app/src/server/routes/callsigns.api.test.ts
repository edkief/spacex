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
import { createSessionService, SESSION_TTL_MS } from '@server/auth/session';
import { registerApiRoutes } from '@server/routes';
import { homeSystemIdForPlayer } from '@shared/galaxy/home';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'api-test-secret',
  GALAXY_SEED: 'drift-dev-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
};

const GALAXY_SEED = env.GALAXY_SEED;

let dir: string;
let app: FastifyInstance;
let repo: ReturnType<typeof createRepo>;
let codec: ReturnType<typeof createTokenCodec>;
let sessions: ReturnType<typeof createSessionService>;
/** Token from the 'Foxtrot-7' claim; shared between the two skew tests. */
let foxtrotToken = '';

// Fake clock shared by the session service (start = real now) so expiry tests
// can advance time deterministically; advance only in the late tests.
let nowMs = Date.now();

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-auth-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'test.db') });
  repo = createRepo(db, sqliteTables);
  codec = createTokenCodec('api-test-secret', { now: () => nowMs });
  sessions = createSessionService({ repo, codec, now: () => nowMs });
  app = buildServer(env);
  registerApiRoutes(app, { repo, sessions, galaxySeed: GALAXY_SEED });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function claim(callsign: string) {
  return app.inject({ method: 'POST', url: '/api/callsigns', payload: { callsign } });
}

async function sessionOf(token: string) {
  return app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('POST /api/callsigns', () => {
  it('claims a callsign: creates the player + starter ship and issues a token', async () => {
    const res = await claim('Alpha-1');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.callsign).toBe('alpha-1'); // normalized case-insensitive
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.playerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.homeSystemId).toMatch(/^[0-9a-f]{16}$/);
    expect(body.homeSystemId).toBe(homeSystemIdForPlayer(GALAXY_SEED, body.playerId));

    const player = await repo.findPlayerByCallsign('alpha-1');
    expect(player?.id).toBe(body.playerId);
    expect(player?.credits).toBe(500);
    const ship = await repo.getOrCreateStarterShip(body.playerId);
    expect(ship.classId).toBe('scout');
    expect(ship.position.systemId).toBe(body.homeSystemId);

    // The issued token must verify end-to-end (signature + sessions row).
    const check = await sessions.verify(body.token);
    expect(check.ok).toBe(true);
  });

  it('returns 409 callsign-taken for a duplicate claim', async () => {
    const res = await claim('alpha-1');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'callsign-taken' });
  });

  it('uniqueness is case-insensitive', async () => {
    expect((await claim('Bravo-9')).statusCode).toBe(201);
    const dup = await claim('BRAVO-9');
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'callsign-taken' });
  });

  it('rejects invalid callsigns with 400 invalid-callsign', async () => {
    for (const callsign of ['ab', 'a'.repeat(17), 'bad_chars', '', 42]) {
      const res = await claim(callsign as string);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid-callsign' });
    }
  });

  it('rejects unknown body fields (strict schema)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callsigns',
      payload: { callsign: 'Delta-0', password: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid-callsign' });
  });
});

describe('GET /api/session', () => {
  it('returns the player profile for a valid bearer token', async () => {
    const { token } = (await claim('Echo-5')).json();
    const res = await sessionOf(token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.callsign).toBe('echo-5');
    expect(body.credits).toBe(500);
    expect(body.homeSystemId).toMatch(/^[0-9a-f]{16}$/);
    expect(body.shipId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 401 with a structured error when the header is missing or malformed', async () => {
    for (const headers of [{}, { authorization: 'Basic abc' }]) {
      const res = await app.inject({ method: 'GET', url: '/api/session', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'missing bearer token' });
    }
  });

  it('rejects a token signed with the wrong secret (invalid signature)', async () => {
    const otherCodec = createTokenCodec('a-different-secret', { now: () => nowMs });
    const token = otherCodec.sign({
      playerId: (await repo.findPlayerByCallsign('echo-5'))!.id,
      exp: Math.floor((nowMs + 3600_000) / 1000),
    });
    const res = await sessionOf(token);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'invalid-signature' });
  });

  it('rejects a well-signed token that was never issued (unknown session)', async () => {
    const token = codec.sign({
      playerId: '00000000-0000-4000-8000-000000000000',
      exp: Math.floor((nowMs + 3600_000) / 1000),
    });
    const res = await sessionOf(token);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'unknown-session' });
  });

  it('never echoes the raw token in a 401 response', async () => {
    const res = await sessionOf('not.a-token');
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('not.a-token');
  });

  it('accepts a token up to 30 s past the TTL (fake clock, skew window)', async () => {
    const { token } = (await claim('Foxtrot-7')).json();
    foxtrotToken = token;
    nowMs += SESSION_TTL_MS + 29_000;
    const res = await sessionOf(token);
    expect(res.statusCode).toBe(200);
    expect(res.json().callsign).toBe('foxtrot-7');
  });

  it('expires the session once the skew window is exceeded (fake clock)', async () => {
    // 2 s later: 31 s past the TTL, outside the 30 s skew tolerance.
    nowMs += 2_000;
    const res = await sessionOf(foxtrotToken);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'expired-token' });
  });
});
