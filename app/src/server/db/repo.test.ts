import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSQLite3 from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from '@server/db/client';
import { migrateSqlite } from '@server/db/migrate';
import { CallsignTakenError, InsufficientCreditsError, NotFoundError } from '@server/db/errors';
import { createRepo } from '@server/db/repo';
import { sqliteTables, type ShipPosition, type ShipRow } from '@server/db/schema';
import { SHIP_CLASSES } from '@shared/ships';

let dir: string;
let repo: ReturnType<typeof createRepo>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-db-'));
  const dbFile = path.join(dir, 'test.db');
  const { db } = createDb({ driver: 'sqlite', dbPath: dbFile });
  repo = createRepo(db, sqliteTables);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('repo: players', () => {
  it('createPlayer returns a row with the 500-credit default', async () => {
    const p = await repo.createPlayer({ callsign: 'NOVA-1', homeSystemId: 'sys-0' });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.callsign).toBe('NOVA-1');
    expect(p.credits).toBe(500);
    expect(p.homeSystemId).toBe('sys-0');
    expect(new Date(p.createdAt).toISOString()).toBe(p.createdAt);
  });

  it('createPlayer honours an explicit credit balance', async () => {
    const p = await repo.createPlayer({ callsign: 'NOVA-2', homeSystemId: 'sys-0', credits: 10 });
    expect(p.credits).toBe(10);
  });

  it('duplicate callsign raises CallsignTakenError', async () => {
    await expect(
      repo.createPlayer({ callsign: 'NOVA-1', homeSystemId: 'sys-9' }),
    ).rejects.toBeInstanceOf(CallsignTakenError);
  });

  it('findPlayerByCallsign round-trips and returns undefined for unknowns', async () => {
    const found = await repo.findPlayerByCallsign('NOVA-1');
    expect(found?.callsign).toBe('NOVA-1');
    expect(await repo.findPlayerByCallsign('GHOST')).toBeUndefined();
  });
});

describe('repo: ships', () => {
  let player: { id: string };
  let ship: ShipRow;

  beforeAll(async () => {
    player = await repo.createPlayer({ callsign: 'PILOT', homeSystemId: 'sys-0' });
    ship = await repo.getOrCreateStarterShip(player.id);
  });

  it('getOrCreateStarterShip creates a docked scout at 100/100', async () => {
    expect(ship.ownerId).toBe(player.id);
    expect(ship.classId).toBe('scout');
    expect(ship.hull).toBe(100);
    expect(ship.shields).toBe(100);
    expect(ship.state).toBe('docked');
    expect(ship.position).toEqual({ systemId: 'home', x: 0, y: 0, z: 0 });
    expect(ship.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(ship.livery).toEqual(SHIP_CLASSES.scout.defaultLivery);
  });

  it('getOrCreateStarterShip is idempotent per player', async () => {
    const again = await repo.getOrCreateStarterShip(player.id);
    expect(again.id).toBe(ship.id);
  });

  it('respects explicit class and position options', async () => {
    const other = await repo.createPlayer({ callsign: 'PILOT-2', homeSystemId: 'sys-1' });
    const pos = { systemId: 'sys-1', x: 1, y: 2, z: 3 };
    const s = await repo.getOrCreateStarterShip(other.id, { classId: 'freighter', position: pos });
    expect(s.classId).toBe('freighter');
    expect(s.position).toEqual(pos);
  });

  it('saveShipState persists hull, shields, position, velocity, state', async () => {
    const pos = { systemId: 'sys-0', x: 42, y: -1.5, z: 0 };
    const saved = await repo.saveShipState(ship.id, {
      hull: 55.5,
      shields: 10,
      position: pos,
      velocity: { x: 1, y: 0, z: -2 },
      state: 'flying',
    });
    expect(saved.hull).toBeCloseTo(55.5);
    expect(saved.shields).toBe(10);
    expect(saved.position).toEqual(pos);
    expect(saved.velocity).toEqual({ x: 1, y: 0, z: -2 });
    expect(saved.state).toBe('flying');

    const again = await repo.getOrCreateStarterShip(player.id);
    expect(again.position).toEqual(pos);
    expect(again.state).toBe('flying');
  });

  it('saveShipState rejects malformed JSON-column payloads (zod)', async () => {
    await expect(
      repo.saveShipState(ship.id, {
        hull: 1,
        shields: 1,
        position: { x: 0, y: 0, z: 0 } as unknown as ShipPosition, // missing systemId
        velocity: { x: 0, y: 0, z: 0 },
        state: 'flying',
      }),
    ).rejects.toThrow();
    await expect(
      repo.saveShipState(ship.id, {
        hull: 1,
        shields: 1,
        position: { systemId: 's', x: NaN, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        state: 'flying',
      }),
    ).rejects.toThrow();
  });

  it('saveShipState on an unknown ship raises NotFoundError', async () => {
    await expect(
      repo.saveShipState('nope', {
        hull: 1,
        shields: 1,
        position: { systemId: 's', x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        state: 'docked',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('repo: cargo', () => {
  it('saveCargo inserts then upserts on (ship_id, resource_type)', async () => {
    const p = await repo.createPlayer({ callsign: 'CARGO-1', homeSystemId: 'sys-0' });
    const s = await repo.getOrCreateStarterShip(p.id);
    const a = await repo.saveCargo(s.id, 'iron', 30);
    expect(a.quantity).toBe(30);
    const b = await repo.saveCargo(s.id, 'iron', 12);
    expect(b.quantity).toBe(12);
    expect(b.id).toBe(a.id); // unique(ship_id, resource_type) → update, not new row
    await repo.saveCargo(s.id, 'copper', 7);
    const iron = await repo.saveCargo(s.id, 'iron', 5);
    expect(iron.quantity).toBe(5);
  });

  it('saveCargo on an unknown ship raises NotFoundError', async () => {
    await expect(repo.saveCargo('nope', 'iron', 1)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('repo: credits', () => {
  let player: { id: string; credits: number };

  beforeAll(async () => {
    player = await repo.createPlayer({ callsign: 'RICH', homeSystemId: 'sys-0' });
  });

  it('addCredits increases the balance', async () => {
    const after = await repo.addCredits(player.id, 100);
    expect(after.credits).toBe(600);
  });

  it('withdrawCredits decreases the balance', async () => {
    const after = await repo.withdrawCredits(player.id, 250);
    expect(after.credits).toBe(350);
  });

  it('insufficient-credits withdraw raises InsufficientCreditsError and leaves the balance untouched', async () => {
    await expect(repo.withdrawCredits(player.id, 10_000)).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    const after = await repo.findPlayerByCallsign('RICH');
    expect(after?.credits).toBe(350);
  });

  it('withdraw on an unknown player raises NotFoundError', async () => {
    await expect(repo.withdrawCredits('nope', 1)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('repo: credits (TASK-41)', () => {
  it('getBalance starts at the 500 default and tracks add/withdraw', async () => {
    const p = await repo.createPlayer({ callsign: 'LEDGER-1', homeSystemId: 'sys-0' });
    expect(await repo.getBalance(p.id)).toBe(500);
    await repo.addCredits(p.id, 250);
    expect(await repo.getBalance(p.id)).toBe(750);
    await repo.withdrawCredits(p.id, 250);
    expect(await repo.getBalance(p.id)).toBe(500);
  });

  it('getBalance on an unknown player raises NotFoundError', async () => {
    await expect(repo.getBalance('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('withdraw honours the zero floor: exact-balance withdraw lands on 0, then any further spend fails', async () => {
    const p = await repo.createPlayer({ callsign: 'FLOOR-1', homeSystemId: 'sys-0' });
    const zeroed = await repo.withdrawCredits(p.id, 500);
    expect(zeroed.credits).toBe(0);
    await expect(repo.withdrawCredits(p.id, 1)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await repo.getBalance(p.id)).toBe(0);
  });

  it('withTransaction commits all writes when the callback resolves', async () => {
    const p = await repo.createPlayer({ callsign: 'TX-OK', homeSystemId: 'sys-0' });
    await repo.withTransaction(async (txn) => {
      await txn.addCredits(p.id, 100);
      await txn.saveShipState((await txn.getOrCreateStarterShip(p.id)).id, {
        hull: 42,
        shields: 80,
        position: { systemId: 'sys-0', x: 1, y: 2, z: 3 },
        velocity: { x: 0, y: 0, z: 0 },
        state: 'docked',
      });
    });
    expect(await repo.getBalance(p.id)).toBe(600);
  });

  it('withTransaction rolls back every write when the callback throws mid-transaction', async () => {
    const p = await repo.createPlayer({ callsign: 'TX-ROLL', homeSystemId: 'sys-0' });
    const ship = await repo.getOrCreateStarterShip(p.id);
    await expect(
      repo.withTransaction(async (txn) => {
        await txn.addCredits(p.id, 500);
        await txn.saveShipState(ship.id, {
          hull: 1,
          shields: 1,
          position: { systemId: 'sys-0', x: 0, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          state: 'destroyed',
        });
        throw new Error('mid-transaction failure');
      }),
    ).rejects.toThrow('mid-transaction failure');
    // Nothing committed: credits and ship state are untouched.
    expect(await repo.getBalance(p.id)).toBe(500);
    const reloaded = await repo.listShipsInSystem(ship.position.systemId);
    const row = reloaded.find((s) => s.id === ship.id)!;
    expect(row.hull).toBe(100);
    expect(row.state).toBe('docked');
  });

  it('100 concurrent withdrawals of 10 against a balance of 500: exactly 50 succeed, final balance 0', async () => {
    const p = await repo.createPlayer({ callsign: 'RACE-1', homeSystemId: 'sys-0' });
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => repo.withdrawCredits(p.id, 10)),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof InsufficientCreditsError,
    );
    expect(succeeded.length).toBe(50);
    expect(failed.length).toBe(50);
    expect(await repo.getBalance(p.id)).toBe(0);
  });
});

describe('repo: resource node state', () => {
  it('upsertNodeState inserts then updates; respawn_at is nullable', async () => {
    const a = await repo.upsertNodeState('sys-1:node-a', 200, null);
    expect(a.quantityRemaining).toBe(200);
    expect(a.respawnAt).toBeNull();
    const b = await repo.upsertNodeState('sys-1:node-a', 80, '2026-01-01T00:00:00.000Z');
    expect(b.nodeId).toBe(a.nodeId);
    expect(b.quantityRemaining).toBe(80);
    expect(b.respawnAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('listNodeStates filters by system prefix', async () => {
    await repo.upsertNodeState('sys-1:node-b', 10, null);
    await repo.upsertNodeState('sys-2:node-c', 20, null);
    const sys1 = await repo.listNodeStates('sys-1');
    expect(sys1.map((n) => n.nodeId).sort()).toEqual(['sys-1:node-a', 'sys-1:node-b']);
    expect(await repo.listNodeStates('sys-2')).toHaveLength(1);
    expect(await repo.listNodeStates('sys-9')).toHaveLength(0);
  });

  it('listNodeStates with explicit nodeIds uses an exact IN query', async () => {
    const rows = await repo.listNodeStates('sys-1', ['sys-1:node-b']);
    expect(rows.map((n) => n.nodeId)).toEqual(['sys-1:node-b']);
  });
});

describe('repo: system registry', () => {
  it('upsertSystem inserts then updates name/last_active_at', async () => {
    const a = await repo.upsertSystem('sys-7', 'Alpha system');
    expect(a.shardActive).toBe(false);
    expect(a.lastActiveAt).toBeTruthy();
    const b = await repo.upsertSystem('sys-7', 'Alpha', true);
    expect(b.name).toBe('Alpha');
    expect(b.shardActive).toBe(true);
    expect(b.systemId).toBe('sys-7');
  });
});

describe('repo: sessions', () => {
  let player: { id: string };

  beforeAll(async () => {
    player = await repo.createPlayer({ callsign: 'SESSION-1', homeSystemId: 'sys-0' });
  });

  it('session CRUD round-trip', async () => {
    const s = await repo.createSession({
      tokenHash: 'tok-1',
      playerId: player.id,
      systemId: 'sys-0',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(s.systemId).toBe('sys-0');

    const found = await repo.findSession('tok-1');
    expect(found?.playerId).toBe(player.id);
    expect(await repo.findSession('missing')).toBeUndefined();

    await repo.setSessionSystem('tok-1', null);
    expect((await repo.findSession('tok-1'))?.systemId).toBeNull();
    await repo.setSessionSystem('tok-1', 'sys-2');
    expect((await repo.findSession('tok-1'))?.systemId).toBe('sys-2');

    await repo.deleteSession('tok-1');
    expect(await repo.findSession('tok-1')).toBeUndefined();
  });

  it('sessions without a system default to null', async () => {
    const s = await repo.createSession({
      tokenHash: 'tok-2',
      playerId: player.id,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(s.systemId).toBeNull();
  });

  it('deleteExpiredSessions removes only expired sessions', async () => {
    await repo.createSession({
      tokenHash: 'tok-expired',
      playerId: player.id,
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    await repo.createSession({
      tokenHash: 'tok-live',
      playerId: player.id,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    const removed = await repo.deleteExpiredSessions('2026-09-29T00:00:00.000Z');
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await repo.findSession('tok-expired')).toBeUndefined();
    expect(await repo.findSession('tok-live')).toBeDefined();
  });
});

describe('migrations', () => {
  it('apply once on a fresh file, then are idempotent', () => {
    const file = path.join(dir, 'fresh.db');
    const raw = new BetterSQLite3(file);
    expect(migrateSqlite(raw)).toBe(6); // 000000..000005 (init / ship_persistence / player_inventory / deposits / ship_cargo / player_settings)
    expect(migrateSqlite(raw)).toBe(0); // tracked in _migrations: nothing to do
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'players',
        'ships',
        'cargo_items',
        'sessions',
        'resource_node_state',
        'system_registry',
        'deposits',
        '_migrations',
      ]),
    );
    raw.close();
  });
});
