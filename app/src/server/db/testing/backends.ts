import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe } from 'vitest';
import { findAppDir } from '../../env.ts';
import { makePgHandle, type DbHandle } from '../connection.ts';
import { createRepository, type Repository } from '../repo.ts';
import { migrationsFolder, openDatabase } from '../open.ts';

const APP_DIR = findAppDir(import.meta.dirname);

/** A controllable clock for deterministic timestamps. */
export interface FakeClock {
  now: () => Date;
  set(ms: number): void;
  advance(ms: number): void;
}

/** An open, migrated, throwaway database plus its repository and clock. */
export interface Fixture {
  backend: BackendName;
  repo: Repository;
  handle: DbHandle;
  clock: FakeClock;
  close(): Promise<void>;
}

export type BackendName = 'sqlite' | 'pglite';
export const BACKENDS: readonly BackendName[] = ['sqlite', 'pglite'];

/** Creates a clock starting at a fixed instant. */
export function fakeClock(startMs = Date.UTC(2030, 0, 1)): FakeClock {
  let current = startMs;
  return {
    now: () => new Date(current),
    set: (ms) => {
      current = ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Opens a fresh SQLite database in a temp dir (never app/data) and migrates it. */
async function openSqliteFixture(clock: FakeClock): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'drift-db-'));
  const opened = await openDatabase(
    { dbDriver: 'sqlite', dbPath: path.join(dir, 'test.db'), databaseUrl: undefined },
    { appDir: APP_DIR, now: clock.now },
  );
  return {
    backend: 'sqlite',
    repo: opened.repo,
    handle: opened.handle,
    clock,
    close: async () => {
      await opened.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Opens an in-process Postgres (PGlite) and applies the committed Postgres migrations. */
async function openPgliteFixture(clock: FakeClock): Promise<Fixture> {
  const client = new PGlite();
  const db = drizzlePglite(client);
  const handle = makePgHandle(
    db,
    (folder) => migratePglite(db, { migrationsFolder: folder }),
    () => client.close(),
  );
  await handle.migrate(migrationsFolder('postgres', APP_DIR));
  return {
    backend: 'pglite',
    repo: createRepository(handle, { now: clock.now }),
    handle,
    clock,
    close: () => handle.close(),
  };
}

/** Opens a fixture for the named backend. */
export function openFixture(backend: BackendName): Promise<Fixture> {
  const clock = fakeClock();
  return backend === 'sqlite' ? openSqliteFixture(clock) : openPgliteFixture(clock);
}

/**
 * Runs `define` once per backend (real SQLite, real Postgres via PGlite) against one shared
 * migrated database per backend. Tests must create their own uniquely named rows.
 */
export function describeBackends(title: string, define: (fixture: () => Fixture) => void): void {
  describe.each(BACKENDS)(`${title} [%s]`, (backend) => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await openFixture(backend);
    }, 30_000);
    afterAll(async () => {
      await fixture.close();
    });
    define(() => fixture);
  });
}

let counter = 0;

/** A unique callsign for tests sharing one database. */
export function uniqueCallsign(prefix = 'pilot'): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}
