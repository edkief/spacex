import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { createDb } from '@server/db/client';
import { createRepo, type Repository } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { createTokenCodec } from '@server/auth/token';
import { createSessionService } from '@server/auth/session';
import { registerApiRoutes } from '@server/routes';
import { createShipSwapBus } from '@server/shards';
import { homeDockPosition } from '@shared/galaxy/dock';
import { homeSystemIdForPlayer } from '@shared/galaxy/home';
import { SHIP_CLASSES } from '@shared/ships';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'ships-test-secret',
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
let repo: Repository;
let sessions: ReturnType<typeof createSessionService>;

interface Claimed {
  callsign: string;
  token: string;
  playerId: string;
  homeSystemId: string;
  shipId: string;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-ships-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'test.db') });
  repo = createRepo(db, sqliteTables);
  sessions = createSessionService({ repo, codec: createTokenCodec('ships-test-secret') });
  app = buildServer(env);
  registerApiRoutes(app, {
    repo,
    sessions,
    galaxySeed: GALAXY_SEED,
    shipSwapBus: createShipSwapBus(),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function claim(callsign: string): Promise<Claimed> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/callsigns',
    payload: { callsign },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Claimed;
}

async function myShips(token: string) {
  return app.inject({
    method: 'GET',
    url: '/api/ships',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function buy(token: string, classId: string) {
  return app.inject({
    method: 'POST',
    url: '/api/ships/buy',
    headers: { authorization: `Bearer ${token}` },
    payload: { classId },
  });
}

describe('GET /api/ships (TASK-20)', () => {
  it('returns the starter ship with class stats merged from the catalog', async () => {
    const p = await claim('Starter-1');
    const res = await myShips(p.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const scout = SHIP_CLASSES.scout;
    expect(body.ship.id).toBe(p.shipId);
    expect(body.ship.classId).toBe('scout');
    expect(body.ship.state).toBe('docked');
    expect(body.ship.hull).toBe(scout.hull);
    expect(body.ship.shields).toBe(scout.shieldCapacity);
    // Merged catalog stats (TASK-19).
    expect(body.class.id).toBe('scout');
    expect(body.class.maxVelocity).toBe(scout.maxVelocity);
    expect(body.class.cargoSlots).toBe(scout.cargoSlots);
    expect(body.class.price).toBe(0);
    // Docked at the seed-derived home-system dock coordinates.
    expect(body.ship.position).toEqual({
      systemId: p.homeSystemId,
      ...homeDockPosition(GALAXY_SEED, p.homeSystemId),
    });
    expect(body.ship.velocity).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('the starter ship id is deterministic per player', async () => {
    const p = await claim('Starter-2');
    expect(p.homeSystemId).toBe(homeSystemIdForPlayer(GALAXY_SEED, p.playerId));
  });

  it('returns 401 without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ships' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'missing bearer token' });
  });
});

describe('POST /api/ships/buy (TASK-20)', () => {
  it('buys each class: scrubs the old ship + cargo, docks the new ship, deducts credits', async () => {
    const p = await claim('Hauler-1');
    await repo.addCredits(p.playerId, 10_000);

    for (const classId of ['freighter', 'interceptor', 'scout'] as const) {
      const cls = SHIP_CLASSES[classId];
      const before = await repo.getBalance(p.playerId);
      const oldShip = (await repo.getShipByOwner(p.playerId))!;
      // Seed some cargo to prove the scrub.
      await repo.saveCargo(oldShip.id, 'iron', 42);
      expect((await repo.listCargo([oldShip.id])).length).toBe(1);

      const res = await buy(p.token, classId);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.ship.classId).toBe(classId);
      expect(body.ship.id).not.toBe(oldShip.id);
      expect(body.ship.state).toBe('docked');
      expect(body.ship.hull).toBe(cls.hull);
      expect(body.ship.shields).toBe(cls.shieldCapacity);
      expect(body.ship.position.systemId).toBe(oldShip.position.systemId);
      expect(body.ship.position).toEqual({
        systemId: p.homeSystemId,
        ...homeDockPosition(GALAXY_SEED, p.homeSystemId),
      });
      expect(body.class.id).toBe(classId);
      expect(body.balance).toBe(before - cls.price);

      // Old ship + its cargo are gone; the player owns exactly one ship.
      expect(await repo.getShip(oldShip.id)).toBeUndefined();
      expect(await repo.listCargo([oldShip.id])).toEqual([]);
      const owned = await repo.getShipByOwner(p.playerId);
      expect(owned?.id).toBe(body.ship.id);
      expect(await repo.getBalance(p.playerId)).toBe(before - cls.price);
    }
  });

  it('rejects a purchase above the balance with 422 insufficient-credits', async () => {
    const p = await claim('Poor-1'); // 500 credits
    const res = await buy(p.token, 'freighter'); // 4000
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe('insufficient-credits');
    expect(body.balance).toBe(500);
    expect(body.price).toBe(4000);
    // Nothing changed.
    expect(await repo.getBalance(p.playerId)).toBe(500);
    const ship = await repo.getShipByOwner(p.playerId);
    expect(ship?.classId).toBe('scout');
  });

  it('rejects an undocked ship with 409 not-docked', async () => {
    const p = await claim('Flying-1');
    const ship = (await repo.getShipByOwner(p.playerId))!;
    await repo.saveShipState(ship.id, {
      hull: ship.hull,
      shields: ship.shields,
      position: ship.position,
      velocity: { x: 1, y: 0, z: 0 },
      state: 'flying',
    });
    const res = await buy(p.token, 'interceptor');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not-docked' });
  });

  it('rejects the currently owned class with 409 already-owned', async () => {
    const p = await claim('Same-1');
    const res = await buy(p.token, 'scout');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'already-owned' });
  });

  it('rejects an unknown class id with 400', async () => {
    const p = await claim('Unknown-1');
    const res = await buy(p.token, 'destroyer');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'unknown-class' });
  });

  it('rejects malformed bodies with 400', async () => {
    const p = await claim('Malformed-1');
    for (const payload of [{}, { classId: 42 }, { classId: 'scout', qty: 1 }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/ships/buy',
        headers: { authorization: `Bearer ${p.token}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('invalid-body');
    }
  });

  it('rejects an unauthenticated buy with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ships/buy',
      payload: { classId: 'interceptor' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'missing bearer token' });
  });

  it('rolls the whole transaction back when a mid-transaction write fails', async () => {
    const p = await claim('Rollback-1');
    await repo.addCredits(p.playerId, 10_000);
    const oldShip = (await repo.getShipByOwner(p.playerId))!;
    await repo.saveCargo(oldShip.id, 'tin', 7);
    const balanceBefore = await repo.getBalance(p.playerId);

    // Simulate a repository failure mid-transaction (the scratch repo is the
    // same instance the transaction callback runs against).
    const original = repo.deleteShipWithCargo;
    repo.deleteShipWithCargo = async () => {
      throw new Error('simulated write failure');
    };
    let res: Awaited<ReturnType<typeof buy>> | undefined;
    try {
      res = await buy(p.token, 'freighter');
    } finally {
      repo.deleteShipWithCargo = original;
    }
    expect(res!.statusCode).toBe(500);

    // Everything is untouched: credits, old ship, its cargo.
    expect(await repo.getBalance(p.playerId)).toBe(balanceBefore);
    expect((await repo.getShip(oldShip.id))?.id).toBe(oldShip.id);
    expect((await repo.listCargo([oldShip.id]))[0]?.quantity).toBe(7);
    expect((await repo.getShipByOwner(p.playerId))?.id).toBe(oldShip.id);
  });
});
