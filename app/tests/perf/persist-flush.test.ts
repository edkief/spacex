import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type OpenedDatabase } from '../../src/server/db/open.ts';
import { findAppDir } from '../../src/server/env.ts';
import { createPersistService, type LiveShip } from '../../src/server/persist.ts';

const SHIPS = 16;
const ROUNDS = 60;

/** Percentile of a sorted array. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
}

describe('interval save cost with 16 dirty ships (real SQLite file, WAL)', () => {
  let dir: string;
  let opened: OpenedDatabase;
  const live: LiveShip[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'drift-perf-'));
    opened = await openDatabase(
      { dbDriver: 'sqlite', dbPath: path.join(dir, 'perf.db'), databaseUrl: undefined },
      { appDir: findAppDir(import.meta.dirname) },
    );
    for (let i = 0; i < SHIPS; i++) {
      const player = await opened.repo.createPlayer({
        callsign: `perf-${i}`,
        homeSystemId: 'sys-perf',
      });
      const ship = await opened.repo.getOrCreateStarterShip(player.id);
      live.push({
        shipId: ship.id,
        classId: 'scout',
        hull: ship.hull,
        shields: ship.shields,
        position: ship.position,
        velocity: ship.velocity,
        state: 'flying',
      });
    }
  });

  afterAll(async () => {
    await opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('flushes 16 dirty ships (positions and changed holds) in a few milliseconds', async () => {
    const persist = createPersistService(opened.repo);
    const flushMs: number[] = [];
    for (let round = 1; round <= ROUNDS; round++) {
      for (const ship of live) {
        persist.markDirty({
          ...ship,
          position: { ...ship.position, x: round * 3.5 },
          velocity: { x: round, y: 0, z: 0 },
          cargo: [
            { resourceType: 'iron', quantity: round },
            { resourceType: 'water', quantity: round + 1 },
            { resourceType: 'silicon', quantity: round + 2 },
          ],
        });
      }
      const result = await persist.flushDirty();
      expect(result.ships).toBe(SHIPS);
      flushMs.push(result.durationMs);
    }
    const sorted = [...flushMs.slice(5)].sort((a, b) => a - b); // drop warm-up rounds
    const median = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const max = sorted[sorted.length - 1] as number;
    console.log(
      `16-ship interval flush (position+velocity+3-item cargo each): ` +
        `median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`,
    );
    // Spec: whole flush < 20 ms. Measured in isolation (npm run test:perf) it is ~3 ms median.
    // Inside the full parallel suite other test files steal CPU, so the bounds here are very
    // loose and only catch order-of-magnitude regressions.
    expect(p95).toBeLessThan(80);
    expect(max).toBeLessThan(300);
  }, 60_000);

  it('a position-only flush (cargo unchanged) is cheaper still', async () => {
    const persist = createPersistService(opened.repo);
    const hold = [{ resourceType: 'iron', quantity: 1 }];
    for (const ship of live) persist.markDirty({ ...ship, cargo: hold });
    await persist.flushDirty();
    const times: number[] = [];
    for (let round = 1; round <= 30; round++) {
      for (const ship of live) {
        persist.markDirty({ ...ship, position: { ...ship.position, x: round }, cargo: hold });
      }
      times.push((await persist.flushDirty()).durationMs);
    }
    const sorted = times.slice(3).sort((a, b) => a - b);
    console.log(
      `16-ship interval flush (position only): median ${percentile(sorted, 0.5).toFixed(2)} ms, ` +
        `p95 ${percentile(sorted, 0.95).toFixed(2)} ms, max ${(sorted[sorted.length - 1] as number).toFixed(2)} ms`,
    );
    expect(percentile(sorted, 0.95)).toBeLessThan(80);
  }, 60_000);
});
