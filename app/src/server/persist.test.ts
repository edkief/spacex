import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb, type Db } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { sqliteTables, type ShipRow } from '@server/db/schema';
import { createPersistService, type PersistService } from '@server/persist';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let dir: string;
let handle: ReturnType<typeof createDb>;
let repo: ReturnType<typeof createRepo>;

/** Player + starter ship in `sys-bench`, unique callsign per tag. */
async function makeShip(tag: string): Promise<ShipRow> {
  const player = await repo.createPlayer({ callsign: `P-${tag}`, homeSystemId: 'sys-bench' });
  return repo.getOrCreateStarterShip(player.id, {
    position: { systemId: 'sys-bench', x: 0, y: 0, z: 0 },
  });
}

function makeService(
  options?: Parameters<typeof createPersistService>[0]['options'],
): PersistService {
  return createPersistService({ handle, repo, options });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-persist-'));
  handle = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'persist.db') });
  repo = createRepo(handle.db, sqliteTables);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('save points', () => {
  it('onDock writes the ship and clears the dirty flag (repository spy)', async () => {
    const ship = await makeShip('dock');
    const svc = makeService();
    const spy = vi.spyOn(repo, 'saveShipState');
    svc.markDirty(ship);
    expect(svc.isDirty(ship.id)).toBe(true);

    const docked = await svc.onDock({
      ...ship,
      state: 'docked',
      position: { systemId: 'sys-bench', x: 5, y: 6, z: 7 },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(ship.id, expect.objectContaining({ state: 'docked' }));
    expect(docked.position.x).toBe(5);
    expect(docked.state).toBe('docked');
    expect(svc.isDirty(ship.id)).toBe(false);
    spy.mockRestore();
  });

  it('onDamage writes only on downward 75/50/25 hull crossings', async () => {
    const ship = await makeShip('dmg');
    const svc = makeService();
    const spy = vi.spyOn(repo, 'saveShipState');
    const at = (hull: number): ShipRow => ({ ...ship, hull });

    expect(await svc.onDamage(at(80))).toBe(false); // first sight = baseline
    expect(await svc.onDamage(at(70))).toBe(true); // crosses 75
    expect(await svc.onDamage(at(60))).toBe(false); // between milestones
    expect(await svc.onDamage(at(40))).toBe(true); // crosses 50
    expect(await svc.onDamage(at(30))).toBe(false);
    expect(await svc.onDamage(at(20))).toBe(true); // crosses 25
    expect(await svc.onDamage(at(90))).toBe(false); // repair, no write
    expect(await svc.onDamage(at(85))).toBe(false);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(svc.lastSavedHull(ship.id)).toBe(20);
    spy.mockRestore();
  });

  it('interval save (5 s cadence, shortened) writes dirty ships in one transaction', async () => {
    const ship = await makeShip('interval');
    let txCalls = 0;
    const svc = makeService({
      intervalMs: 25,
      repoForTransaction: (tx) => {
        txCalls += 1;
        return createRepo(tx as Db, sqliteTables);
      },
    });
    svc.markDirty({ ...ship, position: { systemId: 'sys-bench', x: 42, y: 0, z: 0 } });
    svc.start();
    try {
      await vi.waitFor(() => expect(txCalls).toBeGreaterThan(0));
    } finally {
      svc.stop();
    }
    expect(svc.isDirty(ship.id)).toBe(false);
    const reloaded = (await repo.listShipsInSystem('sys-bench')).find((s) => s.id === ship.id);
    expect(reloaded?.position.x).toBe(42);

    // interval save skips clean ships: no new transaction, nothing saved
    const summary = await svc.saveDirty();
    expect(summary).toEqual({ saved: 0, ms: 0 });
    expect(txCalls).toBe(1);
  });

  it('onShardShutdown flushes dirty ships + node states in one transaction', async () => {
    const ship = await makeShip('shut');
    let txCalls = 0;
    const svc = makeService({
      repoForTransaction: (tx) => {
        txCalls += 1;
        return createRepo(tx as Db, sqliteTables);
      },
    });
    svc.markDirty({
      ...ship,
      hull: 33,
      position: { systemId: 'sys-bench', x: 11, y: 12, z: 13 },
    });

    const summary = await svc.onShardShutdown('sys-bench', [
      { nodeId: 'sys-bench:node-a', quantityRemaining: 5 },
    ]);

    expect(txCalls).toBe(1);
    expect(summary.saved).toBe(1);
    expect(svc.dirtyShipIds()).toHaveLength(0);
    const reloaded = await svc.loadSystemState('sys-bench');
    const s = reloaded.ships.find((row) => row.id === ship.id);
    expect(s?.position.x).toBe(11);
    expect(s?.hull).toBe(33);
    expect(reloaded.nodeStates).toContainEqual({
      nodeId: 'sys-bench:node-a',
      quantityRemaining: 5,
      respawnAt: null,
    });
  });

  it('saveCargo batched: one transaction, rolled back wholesale on error', async () => {
    const ship = await makeShip('cargo');
    const svc = makeService();

    await svc.saveCargo(ship.id, [{ resourceType: 'iron', quantity: 10 }]);
    await expect(
      svc.saveCargo(ship.id, [
        { resourceType: 'copper', quantity: 20 },
        { resourceType: 'water', quantity: -5 },
      ]),
    ).rejects.toThrow();

    // copper upsert happened earlier in the same tx → rolled back
    const cargo = await repo.listCargo([ship.id]);
    expect(cargo).toHaveLength(1);
    expect(cargo[0].resourceType).toBe('iron');
    expect(cargo[0].quantity).toBe(10);
  });

  it('saveShip updates the ships row and clears dirty', async () => {
    const ship = await makeShip('plain');
    const svc = makeService();
    svc.markDirty(ship);
    const saved = await svc.saveShip({
      ...ship,
      hull: 12.5,
      position: { systemId: 'sys-bench', x: -1, y: 2, z: 3 },
    });
    expect(saved.hull).toBeCloseTo(12.5);
    expect(saved.position.x).toBe(-1);
    expect(svc.isDirty(ship.id)).toBe(false);
  });
});

describe('loadSystemState', () => {
  it('returns ships, cargo, credits and node states for the system only', async () => {
    const p1 = await repo.createPlayer({
      callsign: 'LOAD-A',
      homeSystemId: 'sys-load',
      credits: 1234,
    });
    const p2 = await repo.createPlayer({
      callsign: 'LOAD-B',
      homeSystemId: 'sys-load',
      credits: 7,
    });
    const s1 = await repo.getOrCreateStarterShip(p1.id, {
      position: { systemId: 'sys-load', x: 1, y: 2, z: 3 },
    });
    const s2 = await repo.getOrCreateStarterShip(p2.id, {
      position: { systemId: 'sys-load', x: 9, y: 8, z: 7 },
    });
    const svc = makeService();
    await svc.saveCargo(s1.id, [
      { resourceType: 'iron', quantity: 300 },
      { resourceType: 'water', quantity: 40 },
    ]);
    await svc.saveNodeStates('sys-load', [
      { nodeId: 'sys-load:n1', quantityRemaining: 12 },
      { nodeId: 'sys-load:n2', quantityRemaining: 0, respawnAt: '2026-01-01T00:00:00.000Z' },
    ]);

    const st = await svc.loadSystemState('sys-load');
    expect(st.systemId).toBe('sys-load');
    expect(st.ships).toHaveLength(2);
    expect(st.ships.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    const byType = Object.fromEntries(st.cargo.map((c) => [c.resourceType, c.quantity]));
    expect(byType).toEqual({ iron: 300, water: 40 });
    expect(st.credits[p1.id]).toBe(1234);
    expect(st.credits[p2.id]).toBe(7);
    expect(st.nodeStates).toContainEqual({
      nodeId: 'sys-load:n1',
      quantityRemaining: 12,
      respawnAt: null,
    });
    expect(st.nodeStates).toContainEqual({
      nodeId: 'sys-load:n2',
      quantityRemaining: 0,
      respawnAt: '2026-01-01T00:00:00.000Z',
    });

    // other systems are not leaked
    const bench = await svc.loadSystemState('sys-bench');
    expect(bench.ships.some((s) => s.id === s1.id)).toBe(false);
  });
});

describe('crash recovery (step 3)', () => {
  it('SIGKILL after save: loadSystemState restores position, cargo, credits', async () => {
    const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-crash-'));
    const dbPath = path.join(crashDir, 'crash.db');
    const systemId = 'crashsys01';
    const payload = {
      callsign: 'CRASH-PILOT',
      credits: 1234,
      classId: 'freighter',
      systemId,
      position: { x: 123.4, y: -56.7, z: 89.1 },
      velocity: { x: 1.5, y: 0, z: -0.5 },
      hull: 42.5,
      shields: 11,
      state: 'flying' as const,
      cargo: [
        { resourceType: 'iron', quantity: 300 },
        { resourceType: 'water', quantity: 77 },
      ],
    };

    const childScript = path.join(appDir, 'src', 'server', 'persist-crash-child.ts');
    // Invoke tsx's loader flags directly (same command line the tsx CLI
    // builds) so the spawned PID is the script's own node process — any
    // intermediate wrapper would make child.kill() orphan the real process.
    const tsxDist = path.join(appDir, 'node_modules', 'tsx', 'dist');
    const child = spawn(
      process.execPath,
      [
        '--require',
        path.join(tsxDist, 'preflight.cjs'),
        '--import',
        pathToFileURL(path.join(tsxDist, 'loader.mjs')).href,
        childScript,
        dbPath,
        JSON.stringify(payload),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error(`child did not become ready (stdout: ${stdout}; stderr: ${stderr})`)),
          45000,
        );
        child.stdout.on('data', () => {
          if (stdout.includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('error', reject);
      });

      // ungraceful death: SIGKILL, no cleanup handlers run
      child.kill('SIGKILL');
      const { signal } = await new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (_code, sig) => resolve({ signal: sig }));
      });
      expect(signal).toBe('SIGKILL');
    } finally {
      child.kill();
    }

    try {
      // restart: open the same file and load through the real path
      const freshHandle = createDb({ driver: 'sqlite', dbPath });
      const freshRepo = createRepo(freshHandle.db, sqliteTables);
      const svc = createPersistService({ handle: freshHandle, repo: freshRepo });
      const st = await svc.loadSystemState(systemId);

      expect(st.ships).toHaveLength(1);
      const ship = st.ships[0];
      const dist = Math.hypot(
        ship.position.x - payload.position.x,
        ship.position.y - payload.position.y,
        ship.position.z - payload.position.z,
      );
      expect(dist).toBeLessThan(100); // 100 m tolerance
      expect(ship.position.x).toBeCloseTo(payload.position.x);
      expect(ship.hull).toBeCloseTo(payload.hull);
      expect(ship.state).toBe('flying');
      const byType = Object.fromEntries(st.cargo.map((c) => [c.resourceType, c.quantity]));
      expect(byType).toEqual({ iron: 300, water: 77 }); // cargo exact
      expect(st.credits[ship.ownerId]).toBe(1234); // credits exact
    } finally {
      fs.rmSync(crashDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('performance guard (step 4)', () => {
  it('16 dirty ships: one interval save < 20 ms, no single write > 5 ms', async () => {
    const ships: ShipRow[] = [];
    for (let i = 0; i < 16; i++) {
      const s = await makeShip(`bench-${i}`);
      ships.push({
        ...s,
        hull: 100 - i,
        position: { systemId: 'sys-bench', x: i * 10, y: i, z: -i },
      });
    }

    // Time each per-ship write *inside the batched transaction* (the
    // production hot path; one fsync per save point, not per ship).
    const perShip: number[] = [];
    const svc = makeService({
      repoForTransaction: (tx) => {
        const txRepo = createRepo(tx as Db, sqliteTables);
        return {
          ...txRepo,
          async saveShipState(id: string, state: Parameters<typeof txRepo.saveShipState>[1]) {
            const t0 = performance.now();
            const row = await txRepo.saveShipState(id, state);
            perShip.push(performance.now() - t0);
            return row;
          },
        };
      },
    });

    const markAll = () => {
      for (const s of ships) svc.markDirty(s);
    };
    markAll();
    await svc.saveDirty(); // warmup: settle pages/fs, prime the cache
    perShip.length = 0;
    markAll();
    const summary = await svc.saveDirty();

    const maxWrite = perShip.length > 0 ? Math.max(...perShip) : 0;
    console.log(
      `[persist bench] 16 ships: total ${summary.ms.toFixed(3)} ms, ` +
        `max single write ${maxWrite.toFixed(3)} ms`,
    );
    expect(summary.saved).toBe(16);
    expect(summary.ms).toBeLessThan(20);
    expect(maxWrite).toBeLessThan(5);
    expect(svc.dirtyShipIds()).toHaveLength(0);
  });
});
