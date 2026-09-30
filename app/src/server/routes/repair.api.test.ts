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
import { SHIP_CLASSES } from '@shared/ships';
import { repairCost } from '@shared/physics/damage';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'repair-test-secret',
  GALAXY_SEED: 'drift-dev-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
};

/**
 * POST /api/ships/repair (TASK-23 step 3): docked check, cost from the class
 * maxes, withdraw + full restore in ONE transaction, errors for not-docked
 * and insufficient credits, and rollback when the reset write fails.
 */

let dir: string;
let app: FastifyInstance;
let repo: Repository;

interface Claimed {
  callsign: string;
  token: string;
  playerId: string;
  homeSystemId: string;
  shipId: string;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-repair-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'test.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('repair-test-secret') });
  app = buildServer(env);
  registerApiRoutes(app, {
    repo,
    sessions,
    galaxySeed: env.GALAXY_SEED,
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

/** Damage the player's docked ship to the given absolute hull/shield points. */
async function damage(p: Claimed, hull: number, shields: number): Promise<void> {
  const ship = (await repo.getShipByOwner(p.playerId))!;
  await repo.saveShipState(ship.id, {
    hull,
    shields,
    position: ship.position,
    velocity: { x: 0, y: 0, z: 0 },
    state: ship.state,
  });
}

async function repair(p: Claimed) {
  return app.inject({
    method: 'POST',
    url: '/api/ships/repair',
    headers: { authorization: `Bearer ${p.token}` },
  });
}

describe('POST /api/ships/repair (TASK-23)', () => {
  it('repairs a docked ship: full restore, cost deducted per the class-max formula', async () => {
    const p = await claim('Repair-1');
    await damage(p, 40, 10); // scout: 100 hull / 50 shields
    const cls = SHIP_CLASSES.scout;
    const cost = repairCost('scout', 40, 10); // = ceil(6) + ceil(4) = 10
    expect(cost).toBe(10);
    const before = await repo.getBalance(p.playerId);

    const res = await repair(p);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cost).toBe(10);
    expect(body.balance).toBe(before - 10);
    expect(body.ship.hull).toBe(cls.hull);
    expect(body.ship.shields).toBe(cls.shieldCapacity);
    expect(body.ship.state).toBe('docked');

    // Persisted: the row is fully restored and the balance moved.
    const ship = (await repo.getShipByOwner(p.playerId))!;
    expect(ship.hull).toBe(cls.hull);
    expect(ship.shields).toBe(cls.shieldCapacity);
    expect(await repo.getBalance(p.playerId)).toBe(before - 10);
  });

  it('computes the cost from the class maxes for each class', async () => {
    const callsigns = { freighter: 'Hauler-1', interceptor: 'Dagger-1' } as const;
    for (const classId of ['freighter', 'interceptor'] as const) {
      const p = await claim(callsigns[classId]);
      await repo.addCredits(p.playerId, 10_000);
      const res = await app.inject({
        method: 'POST',
        url: '/api/ships/buy',
        headers: { authorization: `Bearer ${p.token}` },
        payload: { classId },
      });
      expect(res.statusCode).toBe(201);
      const cls = SHIP_CLASSES[classId];
      // Half-damage in points: hull/2, shields/2.
      await damage(p, cls.hull / 2, cls.shieldCapacity / 2);
      const r = await repair(p);
      expect(r.statusCode).toBe(200);
      expect(r.json().cost).toBe(5 + 3); // ceil(0.5*10) + ceil(0.5*5)
      const ship = (await repo.getShipByOwner(p.playerId))!;
      expect(ship.hull).toBe(cls.hull);
      expect(ship.shields).toBe(cls.shieldCapacity);
    }
  });

  it('a full ship costs 0 and still succeeds (no-op restore)', async () => {
    const p = await claim('Full-1');
    const before = await repo.getBalance(p.playerId);
    const res = await repair(p);
    expect(res.statusCode).toBe(200);
    expect(res.json().cost).toBe(0);
    expect(res.json().balance).toBe(before);
    expect(await repo.getBalance(p.playerId)).toBe(before);
  });

  it('rejects an undocked ship with 409 not-docked', async () => {
    const p = await claim('Flying-1');
    const ship = (await repo.getShipByOwner(p.playerId))!;
    await repo.saveShipState(ship.id, {
      hull: 10,
      shields: 5,
      position: ship.position,
      velocity: { x: 1, y: 0, z: 0 },
      state: 'flying',
    });
    const res = await repair(p);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not-docked' });
    // Nothing changed.
    const after = (await repo.getShipByOwner(p.playerId))!;
    expect(after.hull).toBe(10);
    expect(after.shields).toBe(5);
  });

  it('rejects when credits are insufficient with 422 (ship untouched, nothing deducted)', async () => {
    const p = await claim('Poor-1'); // 500 credits
    await damage(p, 0, 0); // destroyed ship: cost 15
    // Spend the balance down to 5 so the 15-credit repair cannot pay.
    await repo.withTransaction(async (tx) => {
      await tx.withdrawCredits(p.playerId, 495); // 500 -> 5
    });
    const res = await repair(p);
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe('insufficient-credits');
    expect(body.balance).toBe(5);
    expect(body.cost).toBe(15);
    expect(await repo.getBalance(p.playerId)).toBe(5); // nothing deducted
    const ship = (await repo.getShipByOwner(p.playerId))!;
    expect(ship.hull).toBe(0); // ship untouched
    expect(ship.shields).toBe(0);
  });

  it('rejects an unauthenticated repair with 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ships/repair' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated', reason: 'missing bearer token' });
  });

  it('rejects a player with no ship with 404', async () => {
    const p = await claim('Shipless-1');
    const ship = (await repo.getShipByOwner(p.playerId))!;
    await repo.deleteShipWithCargo(ship.id);
    const res = await repair(p);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'no-ship' });
  });

  it('rolls the whole transaction back when the reset write fails mid-transaction', async () => {
    const p = await claim('Rollback-1');
    await damage(p, 40, 10);
    const balanceBefore = await repo.getBalance(p.playerId);

    // Simulate a repository failure on the restore write (the scratch repo is
    // the same instance the transaction callback runs against).
    const original = repo.saveShipState;
    repo.saveShipState = async () => {
      throw new Error('simulated write failure');
    };
    let res: Awaited<ReturnType<typeof repair>> | undefined;
    try {
      res = await repair(p);
    } finally {
      repo.saveShipState = original;
    }
    expect(res!.statusCode).toBe(500);

    // The spend rolled back with the failed restore: balance and ship intact.
    expect(await repo.getBalance(p.playerId)).toBe(balanceBefore);
    const ship = (await repo.getShipByOwner(p.playerId))!;
    expect(ship.hull).toBe(40);
    expect(ship.shields).toBe(10);
  });
});
