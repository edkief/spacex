import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import { createApp } from '../app';
import { repo } from '../db/repo';
import { db, initDb, migrate } from '../db/client';
import { verifyToken, hashToken, signToken } from '../auth/token';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

const TEST_DB_PATH = path.join('/tmp/opencode', 'test-ships.sqlite');

describe('Ships Routes', () => {
  let app: any;
  let token: string;
  let playerId: string;

  beforeEach(async () => {
    // Setup environment for SQLite
    process.env.DB_DRIVER = 'sqlite';
    process.env.DB_PATH = TEST_DB_PATH;

    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    initDb();
    await migrate();

    app = createApp();
    await app.ready();

    // Setup a player and session
    const player = await repo.createPlayer('TestPilot', 'sol');
    playerId = player.id;
    
    token = signToken({ playerId: player.id, systemId: 'sol', exp: Date.now() + 3600000 });
    const tokenHash = hashToken(token);
    await repo.createSession(player.id, 'sol', tokenHash);

    // Ensure player has a ship
    await repo.getOrCreateStarterShip(playerId, 'sol');
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  it('GET /api/ships returns the player ship with merged stats', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ships',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.owner_id).toBe(playerId);
    expect(body.class_id).toBe('scout');
    expect(body.stats).toBeDefined();
    expect(body.stats.name).toBe('Scout');
  });

  it('POST /api/ships/buy allows buying a new ship', async () => {
    // Give player some credits
    await repo.addCredits(playerId, 5000);

    const response = await app.inject({
      method: 'POST',
      url: '/api/ships/buy',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        classId: 'interceptor',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.class_id).toBe('interceptor');

    // Verify credits were deducted (500 + 5000 - 2500 = 3000)
    const player = await repo.findPlayerById(playerId);
    expect(player?.credits).toBe(3000);
  });

  it('POST /api/ships/buy rejects if not docked', async () => {
    const ship = await repo.getShipByOwner(playerId);
    if (ship) {
      await repo.saveShipState(ship.id, { state: 'flying' });
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/ships/buy',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        classId: 'interceptor',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).code).toBe('not-docked');
  });

  it('POST /api/ships/buy rejects if insufficient credits', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ships/buy',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        classId: 'freighter',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).code).toBe('insufficient-credits');
  });

  it('POST /api/ships/buy rejects unknown class', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ships/buy',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        classId: 'battleship',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('unknown-class');
  });

  it('POST /api/ships/buy rejects if already owns that class', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ships/buy',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        classId: 'scout',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).code).toBe('already-owned');
  });
});
