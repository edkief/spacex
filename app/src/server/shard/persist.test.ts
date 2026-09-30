import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { sqliteTables, type ShipRow } from '@server/db/schema';
import { createShipSwapBus } from '@server/shards';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { homeDockPosition } from '@shared/galaxy/dock';
import { quatIdentity, type Quat } from '@shared/physics/vec';
import type { Conn } from '@server/ws';
import { SystemShard } from './shard';
import { createShardPersist, startShardFlushTimer, type ShardPersist } from './persist';
import type { SimEntity } from './types';

const SYSTEM_ID = 'shard-persist-sys';
const SILENT = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

let dir: string;
let repo: ReturnType<typeof createRepo>;

async function makeShip(callsign: string, systemId: string = SYSTEM_ID): Promise<ShipRow> {
  const player = await repo.createPlayer({ callsign, homeSystemId: systemId });
  return repo.getOrCreateStarterShip(player.id, {
    position: { systemId, x: 0, y: 0, z: 0 },
  });
}

/** A minimal in-shard player ship entity (scout, full hull/shields by default). */
function shipEntity(playerId: string, shipId: string, overrides?: Partial<SimEntity>): SimEntity {
  return {
    id: shipId,
    kind: 'ship',
    playerId,
    classId: 'scout',
    ship: {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: quatIdentity(),
      regime: 'space',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    ...overrides,
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-shard-persist-'));
  const handle = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'shard.db') });
  repo = createRepo(handle.db, sqliteTables);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('flushShips (step 1)', () => {
  it('empty shard: no transaction, zero summary', async () => {
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID, options: { log: SILENT } });
    const spy = vi.spyOn(repo, 'withTransaction');
    const summary = await persist.flushShips({
      systemId: SYSTEM_ID,
      entities: new Map(),
    });
    expect(summary).toEqual({ saved: 0, destroyed: 0, ms: 0 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('upserts {pos, vel, quat, regime, hull, shields, livery, onPad} in ONE transaction', async () => {
    const ship = await makeShip('FLUSH-A');
    const quat: Quat = { x: 0, y: 0.7071, z: 0, w: 0.7071 };
    const ownerId = (await repo.getShip(ship.id))!.ownerId;
    const entity = shipEntity(ownerId, ship.id, {
      ship: {
        pos: { x: 10, y: 20, z: 30 },
        vel: { x: 1.5, y: -2, z: 0.25 },
        quat,
        regime: 'space',
      },
      hull: 0.5,
      shields: 0.75,
      livery: { hull: '#123456', accent: '#abcdef', trim: '#000001' },
    });
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID, options: { log: SILENT } });

    let txCount = 0;
    const original = repo.withTransaction.bind(repo);
    const spy = vi.spyOn(repo, 'withTransaction').mockImplementation((fn) => {
      txCount += 1;
      return original(fn);
    });

    const summary = await persist.flushShips({
      systemId: SYSTEM_ID,
      entities: new Map([[ship.id, entity]]),
    });
    spy.mockRestore();

    expect(txCount).toBe(1); // one transaction for the whole flush
    expect(summary).toMatchObject({ saved: 1, destroyed: 0 });

    const row = (await repo.getShip(ship.id))!;
    expect(row.position).toEqual({ systemId: SYSTEM_ID, x: 10, y: 20, z: 30 });
    expect(row.velocity).toEqual({ x: 1.5, y: -2, z: 0.25 });
    expect(row.rotation).toEqual(quat);
    expect(row.regime).toBe('space');
    expect(row.state).toBe('flying');
    expect(row.onPad).toBeNull();
    expect(row.destroyedAt).toBeNull();
    expect(row.hull).toBeCloseTo(50); // 0.5 * scout hull cap 100
    expect(row.shields).toBeCloseTo(37.5); // 0.75 * scout shield cap 50
    expect(row.livery).toEqual({ hull: '#123456', accent: '#abcdef', trim: '#000001' });
  });

  it('missing owner row: creates the ship, then applies the full state (upsert)', async () => {
    const player = await repo.createPlayer({ callsign: 'FLUSH-NOROW', homeSystemId: SYSTEM_ID });
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID, options: { log: SILENT } });
    const summary = await persist.flushShips({
      systemId: SYSTEM_ID,
      entities: new Map([
        [
          'ghost-1',
          shipEntity(player.id, 'ghost-1', {
            ship: {
              pos: { x: 5, y: 6, z: 7 },
              vel: { x: 0, y: 0, z: 1 },
              quat: quatIdentity(),
              regime: 'space',
            },
          }),
        ],
      ]),
    });
    expect(summary).toMatchObject({ saved: 1, destroyed: 0 });
    const row = await repo.getShipByOwner(player.id);
    expect(row).toBeDefined();
    expect(row!.position).toEqual({ systemId: SYSTEM_ID, x: 5, y: 6, z: 7 });
    expect(row!.state).toBe('flying');
  });

  it('destroyed ship: persisted as state=destroyed with the destroyed_at anchor', async () => {
    const ship = await makeShip('FLUSH-DEAD');
    const ownerId = (await repo.getShip(ship.id))!.ownerId;
    const destroyedAtMs = 1_700_000_123_456;
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID, options: { log: SILENT } });
    const summary = await persist.flushShips({
      systemId: SYSTEM_ID,
      entities: new Map([
        // the wreck entity is NOT a row — the owner row carries the state
        [
          ship.id,
          shipEntity(ownerId, ship.id, {
            destroyed: true,
            destroyedAtMs,
            hull: 0,
            shields: 0,
            ship: {
              pos: { x: 1, y: 2, z: 3 },
              vel: { x: 0, y: 0, z: 0 },
              quat: quatIdentity(),
              regime: 'space',
            },
          }),
        ],
        [
          'wreck:' + ship.id,
          {
            id: 'wreck:' + ship.id,
            kind: 'wreck',
            playerId: null,
            classId: 'scout',
            ship: {
              pos: { x: 1, y: 2, z: 3 },
              vel: { x: 0, y: 0, z: 0 },
              quat: quatIdentity(),
              regime: 'space',
            },
            hull: 0,
            shields: 0,
            targetId: null,
            docked: false,
            ttl: 12000,
          },
        ],
      ]),
    });
    expect(summary).toMatchObject({ saved: 1, destroyed: 1 }); // wreck entity not counted
    const row = (await repo.getShip(ship.id))!;
    expect(row.state).toBe('destroyed');
    expect(row.destroyedAt).toBe(new Date(destroyedAtMs).toISOString());
    expect(row.hull).toBe(0);
  });

  it('ship on a pad persists as docked with onPad', async () => {
    const ship = await makeShip('FLUSH-PAD');
    const ownerId = (await repo.getShip(ship.id))!.ownerId;
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID, options: { log: SILENT } });
    await persist.flushShips({
      systemId: SYSTEM_ID,
      entities: new Map([
        [
          ship.id,
          shipEntity(ownerId, ship.id, {
            docked: true,
            ship: {
              pos: { x: 4, y: 5, z: 6 },
              vel: { x: 0, y: 0, z: 0 },
              quat: quatIdentity(),
              regime: 'space',
              onPad: 'pad-abc123',
            },
          }),
        ],
      ]),
    });
    const row = (await repo.getShip(ship.id))!;
    expect(row.state).toBe('docked');
    expect(row.onPad).toBe('pad-abc123');
  });

  it('partial livery must not clobber the 3-slot row value', async () => {
    const ship = await makeShip('FLIVERY');
    const ownerId = (await repo.getShip(ship.id))!.ownerId;
    const before = (await repo.getShip(ship.id))!.livery;
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID, options: { log: SILENT } });
    await persist.flushShips({
      systemId: SYSTEM_ID,
      entities: new Map([
        [
          ship.id,
          shipEntity(ownerId, ship.id, {
            livery: { hull: '#ffffff' } as Record<string, string>, // not a full 3-slot livery
          }),
        ],
      ]),
    });
    expect((await repo.getShip(ship.id))!.livery).toEqual(before);
  });

  it('AI ships (no owner) are skipped', async () => {
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID, options: { log: SILENT } });
    const summary = await persist.flushShips({
      systemId: SYSTEM_ID,
      entities: new Map([
        [
          'ai-1',
          {
            id: 'ai-1',
            kind: 'ai-ship',
            playerId: null,
            classId: 'interceptor',
            ship: {
              pos: { x: 0, y: 0, z: 0 },
              vel: { x: 0, y: 0, z: 0 },
              quat: quatIdentity(),
              regime: 'space',
            },
            hull: 1,
            shields: 1,
            targetId: null,
            docked: false,
          },
        ],
      ]),
    });
    expect(summary).toEqual({ saved: 0, destroyed: 0, ms: 0 });
  });

  it('a failing row rolls back the WHOLE transaction (single atomic flush)', async () => {
    const s1 = await makeShip('FLUSH-RB-1');
    const s2 = await makeShip('FLUSH-RB-2');
    const o1 = (await repo.getShip(s1.id))!.ownerId;
    const o2 = (await repo.getShip(s2.id))!.ownerId;
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID, options: { log: SILENT } });
    await expect(
      persist.flushShips({
        systemId: SYSTEM_ID,
        entities: new Map([
          [
            s1.id,
            shipEntity(o1, s1.id, {
              ship: {
                pos: { x: 1, y: 1, z: 1 },
                vel: { x: 0, y: 0, z: 0 },
                quat: quatIdentity(),
                regime: 'space',
              },
            }),
          ],
          [
            s2.id,
            shipEntity(o2, s2.id, {
              ship: {
                pos: { x: Number.NaN, y: 0, z: 0 }, // fails Vec3 validation inside the tx
                vel: { x: 0, y: 0, z: 0 },
                quat: quatIdentity(),
                regime: 'space',
              },
            }),
          ],
        ]),
      }),
    ).rejects.toThrow();
    // ship 1's write happened earlier in the same tx → rolled back wholesale
    expect((await repo.getShip(s1.id))!.position).toEqual({
      systemId: SYSTEM_ID,
      x: 0,
      y: 0,
      z: 0,
    });
  });
});

describe('loadShips (step 2)', () => {
  const LOAD_SYS = 'shard-load-sys';
  const NOW = 1_700_000_000_000;
  /** Built per test: `repo` only exists after beforeAll. */
  const persist = () =>
    createShardPersist({ repo, systemId: LOAD_SYS, options: { now: () => NOW } });

  it('returns flying + docked ships, unexpired wrecks; deletes expired rows in the same tx', async () => {
    const flying = await makeShip('LOAD-FLY', LOAD_SYS);
    await repo.saveShipState(flying.id, {
      hull: 42,
      shields: 10,
      position: { systemId: LOAD_SYS, x: 1, y: 2, z: 3 },
      velocity: { x: 1, y: 0, z: 0 },
      rotation: quatIdentity(),
      regime: 'atmosphere',
      state: 'flying',
    });
    const docked = await makeShip('LOAD-DOCK', LOAD_SYS); // created docked at origin
    const wreck = await makeShip('LOAD-WRECK-OK', LOAD_SYS);
    await repo.saveShipState(wreck.id, {
      hull: 0,
      shields: 0,
      position: { systemId: LOAD_SYS, x: 5, y: 5, z: 5 },
      velocity: { x: 0, y: 0, z: 0 },
      state: 'destroyed',
      destroyedAt: new Date(NOW - 300_000).toISOString(), // 300 s left of the 600 s ttl
    });
    const expired = await makeShip('LOAD-WRECK-OLD', LOAD_SYS);
    await repo.saveShipState(expired.id, {
      hull: 0,
      shields: 0,
      position: { systemId: LOAD_SYS, x: 6, y: 6, z: 6 },
      velocity: { x: 0, y: 0, z: 0 },
      state: 'destroyed',
      destroyedAt: new Date(NOW - 900_000).toISOString(), // 300 s past ttl
    });
    const corrupt = await makeShip('LOAD-WRECK-NULL', LOAD_SYS);
    await repo.saveShipState(corrupt.id, {
      hull: 0,
      shields: 0,
      position: { systemId: LOAD_SYS, x: 7, y: 7, z: 7 },
      velocity: { x: 0, y: 0, z: 0 },
      state: 'destroyed',
      destroyedAt: null, // no anchor = undecidable ttl → treat as expired
    });
    const other = await makeShip('LOAD-OTHER', 'another-system');

    const load = await persist().loadShips();

    expect(load.systemId).toBe(LOAD_SYS);
    expect(load.ships.map((s) => s.id).sort()).toEqual([flying.id, docked.id].sort());
    const flyRow = load.ships.find((s) => s.id === flying.id)!;
    expect(flyRow.state).toBe('flying');
    expect(flyRow.regime).toBe('atmosphere');
    expect(load.wrecks).toHaveLength(1);
    expect(load.wrecks[0].row.id).toBe(wreck.id);
    expect(load.wrecks[0].remainingMs).toBe(300_000); // 600 s − 300 s elapsed
    expect(load.deletedExpired).toBe(2);
    // no orphan rows after load
    expect(await repo.getShip(expired.id)).toBeUndefined();
    expect(await repo.getShip(corrupt.id)).toBeUndefined();
    expect(await repo.getShip(other.id)).toBeDefined(); // other system untouched
  });

  it('system with no ships: nothing loaded, no deletes', async () => {
    const load = await persist().loadShips(); // 'shard-load-sys' rows exist, none left to delete
    expect(load.deletedExpired).toBe(0);
    const empty = createShardPersist({
      repo,
      systemId: 'shard-load-empty',
      options: { now: () => NOW },
    });
    const noShips = await empty.loadShips();
    expect(noShips.ships).toHaveLength(0);
    expect(noShips.wrecks).toHaveLength(0);
    expect(noShips.deletedExpired).toBe(0);
  });
});

describe('SystemShard restart load (shard spawn, no teleport)', () => {
  const SEED = 'drift-persist-shard-seed';
  const firstStar = generateStars(SEED)[0];
  const system = generateSystem(SEED, firstStar.id);
  let shard: SystemShard;
  let persist: ShardPersist;

  beforeAll(() => {
    shard = new SystemShard({
      systemId: system.systemId,
      galaxySeed: SEED,
      system,
      repo,
      shipSwapBus: createShipSwapBus(),
      log: SILENT,
    });
    persist = createShardPersist({ repo, systemId: system.systemId, options: { log: SILENT } });
  });

  afterAll(() => {
    shard.stop();
  });

  it('rebuilds flying ships at saved state, docked ships at dock coords, wrecks with ttl', async () => {
    const quat: Quat = { x: 0, y: 0.5, z: 0, w: Math.sqrt(0.75) };
    const fly = await makeShip('RD-FLY', system.systemId);
    await repo.saveShipState(fly.id, {
      hull: 50,
      shields: 25,
      position: { systemId: system.systemId, x: 111, y: 22, z: -33 },
      velocity: { x: 4, y: 0, z: -1 },
      rotation: quat,
      regime: 'space',
      state: 'flying',
    });
    const docked = await makeShip('RD-DOCK', system.systemId);
    const wrecked = await makeShip('RD-WRECK', system.systemId);
    const destroyedAt = Date.now() - 300_000;
    await repo.saveShipState(wrecked.id, {
      hull: 0,
      shields: 0,
      position: { systemId: system.systemId, x: 7, y: 8, z: 9 },
      velocity: { x: 0, y: 0, z: 0 },
      rotation: quat,
      regime: 'space',
      state: 'destroyed',
      destroyedAt: new Date(destroyedAt).toISOString(),
    });

    await shard.loadShips(await persist.loadShips());

    const e = shard.entities.get(fly.id)!;
    expect(e.ship.pos).toEqual({ x: 111, y: 22, z: -33 }); // saved position, not the dock
    expect(e.ship.vel).toEqual({ x: 4, y: 0, z: -1 });
    expect(e.ship.quat).toEqual(quat);
    expect(e.hull).toBeCloseTo(0.5); // 50 / 100
    expect(e.shields).toBeCloseTo(0.5); // 25 / 50
    expect(e.docked).toBe(false);

    const dock = homeDockPosition(SEED, system.systemId);
    const d = shard.entities.get(docked.id)!;
    expect(d.docked).toBe(true);
    expect(d.ship.pos).toEqual(dock); // docked ships load at THIS system's dock
    expect(d.ship.vel).toEqual({ x: 0, y: 0, z: 0 });

    const w = shard.entities.get(`wreck:${wrecked.id}`)!;
    expect(w.kind).toBe('wreck');
    expect(w.ship.pos).toEqual({ x: 7, y: 8, z: 9 });
    // ~300 s left of the 600 s ttl at 20 Hz → about 6 000 ticks
    expect(w.ttl).toBeGreaterThan(5_500);
    expect(w.ttl).toBeLessThanOrEqual(6_000);
  });

  it('a join after restart re-adopts the persisted entity instead of re-spawning', async () => {
    const row = (await repo.listShipsInSystem(system.systemId)).find((s) => s.state === 'flying')!;
    const player = (await repo.getPlayersByIds([row.ownerId]))[0];
    const conn = {
      stage: 'authed',
      playerId: player.id,
      callsign: player.callsign,
      socket: { readyState: WebSocket.OPEN, send: () => undefined },
    } as unknown as Conn;

    const entity = await shard.join(conn);
    expect(entity).toBeDefined();
    expect(entity!.id).toBe(row.id);
    expect(entity!.ship.pos).toEqual({ x: 111, y: 22, z: -33 }); // still the saved state
    expect(entity!.ship.vel).toEqual({ x: 4, y: 0, z: -1 });
  });
});

describe('startShardFlushTimer', () => {
  it('fires on the interval, stops cleanly, and survives flush failures', async () => {
    let calls = 0;
    let failNext = true;
    const warnings: string[] = [];
    const stop = startShardFlushTimer({
      intervalMs: 20,
      flush: () => {
        calls += 1;
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('db down'));
        }
        return Promise.resolve();
      },
      log: { ...SILENT, warn: (msg) => warnings.push(msg) },
    });
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    stop();
    const atStop = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(atStop); // stopped: no further flushes
    expect(warnings).toContain('shard flush failed'); // failures log, do not kill
  });
});

describe('performance guard (step 4)', () => {
  it('flushing 16 ships: p95 under 8 ms (one small transaction per flush)', async () => {
    const ships: ShipRow[] = [];
    for (let i = 0; i < 16; i++) ships.push(await makeShip(`PERF-${i}`));
    const view = {
      systemId: SYSTEM_ID,
      entities: new Map(
        ships.map((s, i) => [
          s.id,
          shipEntity(s.ownerId, s.id, {
            ship: {
              pos: { x: i * 10, y: i, z: -i },
              vel: { x: 1, y: 0, z: 0 },
              quat: quatIdentity(),
              regime: 'space',
            },
          }),
        ]),
      ),
    };
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID, options: { log: SILENT } });
    for (let i = 0; i < 3; i++) {
      await persist.flushShips(view); // warmup: settle pages
    }
    const warm = await persist.flushShips(view);
    expect(warm.saved).toBe(16);

    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      samples.push((await persist.flushShips(view)).ms);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
    console.log(
      `[shard persist bench] 16 ships x 40 flushes: p50 ${p50.toFixed(3)} ms, ` +
        `p95 ${p95.toFixed(3)} ms, max ${sorted[sorted.length - 1].toFixed(3)} ms`,
    );
    expect(p95).toBeLessThan(8); // step 4: p95 under 8 ms — one tick is 50 ms
  });
});
