import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { findAppDir } from '../env.ts';
import { openSqlite } from './connection.ts';
import { migrationsFolder, openDatabase, resolveDbPath } from './open.ts';

const run = promisify(execFile);
const APP_DIR = findAppDir(import.meta.dirname);
const temps: string[] = [];

/** Makes a temp dir that is removed after the test. */
function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sqlite connection and migrations', () => {
  it('migrates a fresh file, is idempotent, and sets WAL and foreign keys', async () => {
    const file = path.join(temp('drift-mig-'), 'nested', 'dir', 'fresh.db');
    const handle = openSqlite({ file });
    await handle.migrate(migrationsFolder('sqlite', APP_DIR));
    await handle.migrate(migrationsFolder('sqlite', APP_DIR));
    const tablesFound = await handle.run((db) =>
      Promise.resolve(
        db.all<{ name: string }>(
          sql`select name from sqlite_master where type = 'table' and name not like '\\_\\_%' escape '\\' and name not like 'sqlite_%' order by name`,
        ),
      ),
    );
    expect(tablesFound.map((t) => t.name)).toEqual([
      'cargo_items',
      'players',
      'resource_node_state',
      'sessions',
      'ships',
      'system_registry',
    ]);
    const [journal] = await handle.run((db) =>
      Promise.resolve(db.all<{ journal_mode: string }>(sql`pragma journal_mode`)),
    );
    const [fk] = await handle.run((db) =>
      Promise.resolve(db.all<{ foreign_keys: number }>(sql`pragma foreign_keys`)),
    );
    expect(journal?.journal_mode).toBe('wal');
    expect(fk?.foreign_keys).toBe(1);
    await handle.close();
    expect(existsSync(file)).toBe(true);
  });

  it('resolves a relative DB_PATH against the app dir, not the cwd, and creates its folder', async () => {
    const appDir = temp('drift-app-');
    expect(resolveDbPath('./data/drift.db', appDir)).toBe(path.join(appDir, 'data', 'drift.db'));
    expect(resolveDbPath('/abs/x.db', appDir)).toBe('/abs/x.db');
    const opened = await openDatabase(
      { dbDriver: 'sqlite', dbPath: './data/drift.db', databaseUrl: undefined },
      { appDir, skipMigrate: true },
    );
    await opened.close();
    expect(existsSync(path.join(appDir, 'data', 'drift.db'))).toBe(true);
  });

  it('requires DATABASE_URL for the postgres driver', async () => {
    await expect(
      openDatabase(
        { dbDriver: 'postgres', dbPath: './x.db', databaseUrl: undefined },
        { appDir: APP_DIR, skipMigrate: true },
      ),
    ).rejects.toThrow(/DATABASE_URL/);
  });
});

describe('drizzle-kit parity (no live database needed)', () => {
  /**
   * Runs `drizzle-kit generate` for a dialect into `out` and returns its output. drizzle-kit
   * prefixes `./` to --out (so it must be relative to the app dir) and exits 0 even when it
   * fails, so callers assert on stdout and an empty stderr as well as the exit status.
   */
  async function generate(dialect: 'sqlite' | 'postgresql', schema: string, out: string) {
    const relativeOut = path.relative(APP_DIR, out);
    const { stdout, stderr } = await run(
      'npx',
      [
        'drizzle-kit',
        'generate',
        '--dialect',
        dialect,
        '--schema',
        schema,
        '--out',
        relativeOut,
        '--name',
        'init',
      ],
      { cwd: APP_DIR },
    );
    expect(stderr).toBe('');
    return stdout;
  }

  const cases = [
    ['sqlite', './src/server/db/schema.ts', 'sqlite'],
    ['postgresql', './src/server/db/schema.pg.ts', 'pg'],
  ] as const;

  it.each(cases)(
    '%s: generating from scratch exits 0 and reproduces the committed initial migration',
    async (dialect, schema, folder) => {
      const out = temp('drift-kit-');
      expect(await generate(dialect, schema, out)).toContain('Your SQL migration file');
      const fresh = readFileSync(path.join(out, '0000_init.sql'), 'utf8');
      const committed = readFileSync(
        path.join(APP_DIR, 'drizzle', folder, '0000_init.sql'),
        'utf8',
      );
      expect(fresh).toBe(committed);
      for (const table of [
        'players',
        'ships',
        'cargo_items',
        'sessions',
        'resource_node_state',
        'system_registry',
      ]) {
        expect(fresh).toContain(table);
      }
    },
    60_000,
  );

  it.each(cases)(
    '%s: committed migrations are up to date with the schema (nothing to generate)',
    async (dialect, schema, folder) => {
      const out = temp('drift-kit-');
      mkdirSync(out, { recursive: true });
      cpSync(path.join(APP_DIR, 'drizzle', folder), out, { recursive: true });
      const before = readdirSync(out).sort();
      const stdout = await generate(dialect, schema, out);
      expect(stdout).toMatch(/nothing to migrate/i);
      expect(readdirSync(out).sort()).toEqual(before);
    },
    60_000,
  );
});
