import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { repo } from './repo';
import { db, schema, initDb } from './client';
import { migrate } from './client';
import { CallsignTakenError, InsufficientCreditsError } from './types';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';

const TEST_DB_PATH = path.join('/tmp/opencode', 'test.sqlite');

describe('Repository', () => {
  beforeEach(async () => {
    // Setup environment for SQLite
    process.env.DB_DRIVER = 'sqlite';
    process.env.DB_PATH = TEST_DB_PATH;

    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    initDb();
    await migrate();
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  it('should create a player and find them by callsign', async () => {
    const player = await repo.createPlayer('Ace', 'sol');
    expect(player.callsign).toBe('Ace');

    const found = await repo.findPlayerByCallsign('Ace');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(player.id);
  });

  it('should throw CallsignTakenError when callsign is not unique', async () => {
    await repo.createPlayer('Ace', 'sol');
    await expect(repo.createPlayer('Ace', 'sol')).rejects.toThrow(CallsignTakenError);
  });

  it('should get or create a starter ship', async () => {
    const player = await repo.createPlayer('Pilot', 'sol');
    const ship = await repo.getOrCreateStarterShip(player.id, 'sol');
    expect(ship.owner_id).toBe(player.id);
    expect(ship.class_id).toBe('scout');

    const shipAgain = await repo.getOrCreateStarterShip(player.id, 'sol');
    expect(shipAgain.id).toBe(ship.id);
  });

  it('should save ship state', async () => {
    const player = await repo.createPlayer('Pilot', 'sol');
    const ship = await repo.getOrCreateStarterShip(player.id, 'sol');

    await repo.saveShipState(ship.id, { hull: 50, state: 'flying' });

    // To verify, we can use db directly or add a findShip method to repo.
    // Let's use db.
    const result = await db.select().from(schema.ships).where(eq(schema.ships.id, ship.id));
    expect(result[0].hull).toBe(50);
    expect(result[0].state).toBe('flying');
  });

  it('should save cargo items', async () => {
    const player = await repo.createPlayer('Trader', 'sol');
    const ship = await repo.getOrCreateStarterShip(player.id, 'sol');

    const cargo = [
      { ship_id: ship.id, resource_type: 'Iron', quantity: 10 },
      { ship_id: ship.id, resource_type: 'Water', quantity: 5 },
    ];

    await repo.saveCargo(ship.id, cargo);

    const result = await db
      .select()
      .from(schema.cargo_items)
      .where(eq(schema.cargo_items.ship_id, ship.id));
    expect(result.length).toBe(2);
  });

  it('should add and withdraw credits', async () => {
    const player = await repo.createPlayer('Rich', 'sol');
    await repo.addCredits(player.id, 1000);

    const p1 = await db.select().from(schema.players).where(eq(schema.players.id, player.id));
    expect(p1[0].credits).toBe(1500);

    await repo.withdrawCredits(player.id, 200);
    const p2 = await db.select().from(schema.players).where(eq(schema.players.id, player.id));
    expect(p2[0].credits).toBe(1300);
  });

  it('should throw InsufficientCreditsError when withdrawing too much', async () => {
    const player = await repo.createPlayer('Poor', 'sol');
    await expect(repo.withdrawCredits(player.id, 1000)).rejects.toThrow(InsufficientCreditsError);
  });

  it('should upsert node state', async () => {
    const nodeId = 'node-1';
    const systemId = 'sol';
    await repo.upsertNodeState(nodeId, systemId, 100, null);

    const n1 = await db
      .select()
      .from(schema.resource_node_state)
      .where(eq(schema.resource_node_state.node_id, nodeId));
    expect(n1[0].quantity_remaining).toBe(100);

    await repo.upsertNodeState(nodeId, systemId, 50, new Date());
    const n2 = await db
      .select()
      .from(schema.resource_node_state)
      .where(eq(schema.resource_node_state.node_id, nodeId));
    expect(n2[0].quantity_remaining).toBe(50);
  });

  it('should handle session CRUD', async () => {
    const player = await repo.createPlayer('User', 'sol');
    const session = await repo.createSession(player.id, 'sol', 'test-token-hash');
    expect(session.token_hash).toBeDefined();

    const found = await repo.findSession(session.token_hash);
    expect(found).not.toBeNull();
    expect(found?.player_id).toBe(player.id);

    await repo.deleteSession(session.token_hash);
    const missing = await repo.findSession(session.token_hash);
    expect(missing).toBeNull();
  });
});
