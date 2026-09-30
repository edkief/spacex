import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { createDb, type DbHandle } from '@server/db/client';
import { createRepo, type Repository } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { createTokenCodec } from '@server/auth/token';
import { createSessionService } from '@server/auth/session';
import { registerApiRoutes } from '@server/routes';
import { createShipSwapBus } from '@server/shards';
import { SHIP_CLASSES } from '@shared/ships';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'livery-test-secret',
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
let dbHandle: DbHandle;
let repo: Repository;
const closers: Array<() => void | Promise<void>> = [];
const callsigns: Map<string, { token: string; playerId: string; shipId: string }> = new Map();

/** The union raw handle is sqlite here; close through a common surface. */
function closeDb(raw: DbHandle['raw']): void {
  (raw as { close(): void }).close();
}

/** Idempotent tracker so teardown never double-closes (the restart test
 *  closes the first server mid-suite). */
function track(close: () => void | Promise<void>): void {
  let done = false;
  closers.push(async () => {
    if (done) return;
    done = true;
    await close();
  });
}

function bootServer(r: Repository): FastifyInstance {
  const sessions = createSessionService({
    repo: r,
    codec: createTokenCodec('livery-test-secret'),
  });
  const a = buildServer(env);
  registerApiRoutes(a, {
    repo: r,
    sessions,
    galaxySeed: env.GALAXY_SEED,
    shipSwapBus: createShipSwapBus(),
  });
  track(() => a.close());
  return a;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-livery-'));
  dbHandle = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'livery.db') });
  track(() => closeDb(dbHandle.raw));
  repo = createRepo(dbHandle.db, sqliteTables);
  app = bootServer(repo);
  await app.ready();
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function claim(
  callsign: string,
): Promise<{ token: string; playerId: string; shipId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/callsigns',
    payload: { callsign },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { token: string; playerId: string; shipId: string };
  callsigns.set(callsign, body);
  return body;
}

async function setLivery(callsign: string, colors: Record<string, unknown>) {
  const c = callsigns.get(callsign)!;
  return app.inject({
    method: 'POST',
    url: '/api/ships/livery',
    headers: { authorization: `Bearer ${c.token}` },
    payload: { colors },
  });
}

const PAINT = { hull: '#123456', accent: '#abcdef', trim: '#000001' };

describe('POST /api/ships/livery (TASK-21)', () => {
  it('validates a full 3-slot livery, persists it, and returns the updated ship', async () => {
    const p = await claim('Livery-1');
    const res = await setLivery('Livery-1', PAINT);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ship.id).toBe(p.shipId);
    expect(body.ship.livery).toEqual(PAINT);
    // The catalog class stays merged into the payload.
    expect(body.class.id).toBe('scout');

    // Persisted through the repo boundary.
    const stored = await repo.getShipByOwner(p.playerId);
    expect(stored?.livery).toEqual(PAINT);
    // Everything else is untouched.
    expect(stored?.hull).toBe(SHIP_CLASSES.scout.hull);
    expect(stored?.shields).toBe(SHIP_CLASSES.scout.shieldCapacity);
    expect(stored?.state).toBe('docked');

    // A second update replaces all three slots atomically.
    const again = await setLivery('Livery-1', {
      hull: '#ff0000',
      accent: '#00ff00',
      trim: '#0000ff',
    });
    expect(again.statusCode).toBe(200);
    expect((await repo.getShipByOwner(p.playerId))?.livery).toEqual({
      hull: '#ff0000',
      accent: '#00ff00',
      trim: '#0000ff',
    });
  });

  it('rejects invalid hex colors in any slot with 400', async () => {
    const p = await claim('Livery-2');
    const bad = [
      { hull: 'red', accent: '#abcdef', trim: '#000001' }, // CSS name
      { hull: '#12345', accent: '#abcdef', trim: '#000001' }, // 5 digits
      { hull: '#1234567', accent: '#abcdef', trim: '#000001' }, // 7 digits
      { hull: '#GGGGGG', accent: '#abcdef', trim: '#000001' }, // non-hex chars
      { hull: 42, accent: '#abcdef', trim: '#000001' }, // non-string
      { hull: '#123456', accent: 'abcdef', trim: '#000001' }, // missing #
    ];
    for (const colors of bad) {
      const res = await setLivery('Livery-2', colors);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('invalid-livery');
    }
    // Nothing was written.
    expect((await repo.getShipByOwner(p.playerId))?.livery).toEqual(
      SHIP_CLASSES.scout.defaultLivery,
    );
  });

  it('rejects partial payloads and extra keys with 400', async () => {
    const p = await claim('Livery-3');
    const partial = [
      { hull: '#123456', accent: '#abcdef' }, // missing trim
      { hull: '#123456' }, // missing two slots
      { hull: '#123456', accent: '#abcdef', trim: '#000001', spoiler: '#111111' }, // extra slot
      { hull: '#123456', accent: '#abcdef', trim: '#000001', qty: 2 }, // extra top key
      {}, // empty
    ];
    for (const colors of partial) {
      const res = await setLivery('Livery-3', colors);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('invalid-livery');
    }
    expect((await repo.getShipByOwner(p.playerId))?.livery).toEqual(
      SHIP_CLASSES.scout.defaultLivery,
    );
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ships/livery',
      payload: { colors: PAINT },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'missing bearer token' });
  });

  it('returns 404 for a player with no ship', async () => {
    const p = await claim('Livery-4');
    await repo.deleteShipWithCargo(p.shipId);
    const res = await setLivery('Livery-4', PAINT);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('no-ship');
  });

  it('new ships start at the catalog default livery for their class', async () => {
    const p = await claim('Livery-5');
    await repo.addCredits(p.playerId, 10_000);
    const ship = (await repo.getShipByOwner(p.playerId))!;
    expect(ship.livery).toEqual(SHIP_CLASSES.scout.defaultLivery);

    const buy = await app.inject({
      method: 'POST',
      url: '/api/ships/buy',
      headers: { authorization: `Bearer ${p.token}` },
      payload: { classId: 'interceptor' },
    });
    expect(buy.statusCode).toBe(201);
    const bought = await repo.getShipByOwner(p.playerId);
    expect(bought?.livery).toEqual(SHIP_CLASSES.interceptor.defaultLivery);
  });

  it('survives a server restart (persistence)', async () => {
    const p = await claim('Livery-6');
    const colors = { hull: '#112233', accent: '#445566', trim: '#778899' };
    const res = await setLivery('Livery-6', colors);
    expect(res.statusCode).toBe(200);

    // Full restart: drop the app and the database handle, then boot a new
    // server over the same file. The session lives in the db, so the same
    // token still authenticates, and the livery must come back as written.
    await app.close();
    closeDb(dbHandle.raw);

    const reopened = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'livery.db') });
    track(() => closeDb(reopened.raw));
    const freshRepo = createRepo(reopened.db, sqliteTables);
    const restarted = bootServer(freshRepo);
    await restarted.ready();

    const res2 = await restarted.inject({
      method: 'GET',
      url: '/api/ships',
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res2.statusCode).toBe(200);
    const body = res2.json();
    expect(body.ship.livery).toEqual(colors);
    expect(body.ship.classId).toBe('scout');
  });
});
