import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db/open.ts';
import { findAppDir } from '../../src/server/env.ts';
import { createPersistService } from '../../src/server/persist.ts';

const APP_DIR = findAppDir(import.meta.dirname);
const CHILD = path.join(import.meta.dirname, 'persist-child.ts');
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Starts the child and resolves lines of JSON it prints; kills with SIGKILL when asked. */
function startChild(dbPath: string, mode: string) {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', CHILD, dbPath, mode], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  cleanups.push(() => child.kill('SIGKILL'));
  const messages: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      messages.push(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      buffer = buffer.slice(nl + 1);
    }
    waiters.splice(0).forEach((wake) => wake());
  });
  const waitFor = async (predicate: (m: Record<string, unknown>[]) => boolean) => {
    const deadline = Date.now() + 30_000;
    while (!predicate(messages)) {
      if (Date.now() > deadline) throw new Error('timed out waiting for child output');
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  const kill9 = async () => {
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_code, signal) => resolve(signal)),
    );
    child.kill('SIGKILL');
    return exited;
  };
  return { messages, waitFor, kill9 };
}

/** A fresh temp database path (never app/data). */
function tempDb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'drift-crash-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'crash.db');
}

/** Reopens the database in this (fresh) process and returns a persistence service over it. */
async function restart(dbPath: string) {
  const opened = await openDatabase(
    { dbDriver: 'sqlite', dbPath, databaseUrl: undefined },
    { appDir: APP_DIR },
  );
  cleanups.push(() => void opened.close());
  return { ...opened, persist: createPersistService(opened.repo) };
}

describe('crash recovery (child process killed with SIGKILL)', () => {
  it('restores the last saved state; unsaved in-memory changes are lost, saved data is exact', async () => {
    const dbPath = tempDb();
    const child = startChild(dbPath, 'dock');
    await child.waitFor((m) => m.some((x) => x['ready'] === true));
    expect(await child.kill9()).toBe('SIGKILL');

    const { repo, persist } = await restart(dbPath);
    const state = await persist.loadSystemState('sys-crash');
    expect(state.ships).toHaveLength(1);
    const [ship] = state.ships;
    expect(ship?.state).toBe('docked');
    expect(Math.abs((ship?.position.x ?? 0) - 100.5)).toBeLessThanOrEqual(100);
    expect(ship?.position).toEqual({
      systemId: 'sys-crash',
      frame: 'system',
      x: 100.5,
      y: -20.25,
      z: 3,
    });
    expect(ship?.cargo).toEqual([
      { resourceType: 'iron', quantity: 7 },
      { resourceType: 'water', quantity: 2 },
    ]);
    expect(state.nodeStates).toEqual([
      {
        nodeId: 'crash-node-1',
        systemId: 'sys-crash',
        quantityRemaining: 0,
        respawnAt: new Date(Date.UTC(2040, 0, 1)),
      },
    ]);
    expect((await repo.findPlayerByCallsign('crash-pilot'))?.credits).toBe(500 + 1234);
  }, 60_000);

  it('keeps state saved by the interval timer before the kill', async () => {
    const dbPath = tempDb();
    const child = startChild(dbPath, 'interval');
    await child.waitFor((m) => m.some((x) => x['ready'] === true));
    expect(await child.kill9()).toBe('SIGKILL');

    const { persist } = await restart(dbPath);
    const [ship] = (await persist.loadSystemState('sys-crash')).ships;
    expect(ship?.state).toBe('flying');
    expect(ship?.position.x).toBe(5000.5);
    expect(ship?.cargo).toEqual([{ resourceType: 'iron', quantity: 9 }]);
  }, 60_000);

  it('never exposes a half-written save point: 16 ships stay consistent when killed mid-storm', async () => {
    const dbPath = tempDb();
    const child = startChild(dbPath, 'storm');
    await child.waitFor((m) =>
      m.some((x) => typeof x['savedRound'] === 'number' && x['savedRound'] >= 25),
    );
    expect(await child.kill9()).toBe('SIGKILL');
    const acknowledged = Math.max(
      ...child.messages
        .filter((m) => typeof m['savedRound'] === 'number')
        .map((m) => m['savedRound'] as number),
    );
    const started = Math.max(
      ...child.messages
        .filter((m) => typeof m['startingRound'] === 'number')
        .map((m) => m['startingRound'] as number),
    );

    const { persist, handle } = await restart(dbPath);
    const { ships } = await persist.loadSystemState('sys-crash');
    expect(ships).toHaveLength(16);
    const rounds = new Set(ships.map((s) => s.position.x));
    expect(rounds.size).toBe(1); // all 16 ships come from the same committed transaction
    const [round] = [...rounds] as [number];
    expect(round).toBeGreaterThanOrEqual(acknowledged);
    expect(round).toBeLessThanOrEqual(started);
    for (const ship of ships)
      expect(ship.cargo).toEqual([{ resourceType: 'iron', quantity: round }]);

    const check = await handle.run((db) =>
      Promise.resolve(db.all<{ integrity_check: string }>(sql`pragma integrity_check`)),
    );
    expect(check[0]?.integrity_check).toBe('ok');
  }, 60_000);
});
