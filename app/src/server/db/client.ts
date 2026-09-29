import fs from 'fs';
import path from 'path';
import BetterSQLite3 from 'better-sqlite3';
import { drizzle as sqliteDrizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { loadEnv } from '../env';
import { migrateSqlite } from './migrate';
import { pgTables, sqliteTables } from './schema';

export type Driver = 'sqlite' | 'postgres';

/** Drizzle instance over either driver, built from the shared schema. */
export type Db = BetterSQLite3Database<typeof sqliteTables> | NodePgDatabase<typeof pgTables>;

export interface DbOptions {
  /** Override DB_DRIVER. */
  driver?: Driver;
  /** Override DB_PATH (sqlite only). */
  dbPath?: string;
  /** Override DATABASE_URL (postgres only). */
  databaseUrl?: string;
}

export interface DbHandle {
  db: Db;
  driver: Driver;
  /** Raw driver handle (better-sqlite3 Database or pg Pool). */
  raw: InstanceType<typeof BetterSQLite3> | Pool;
}

/**
 * Build a Drizzle instance from env (DB_DRIVER / DB_PATH / DATABASE_URL).
 * The sqlite driver creates the parent directory if needed and runs pending
 * migrations on boot; the postgres driver opens a pool from DATABASE_URL.
 */
export function createDb(options: DbOptions = {}): DbHandle {
  const env = loadEnv();
  const driver = options.driver ?? env.DB_DRIVER;

  if (driver === 'sqlite') {
    const dbPath = path.resolve(options.dbPath ?? env.DB_PATH);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new BetterSQLite3(dbPath);
    raw.pragma('foreign_keys = ON');
    migrateSqlite(raw);
    const db = sqliteDrizzle(raw, { schema: sqliteTables });
    return { db, driver, raw };
  }

  const url = options.databaseUrl ?? env.DATABASE_URL;
  if (!url || url === 'TODO_FILL_MANUALLY') {
    throw new Error('DATABASE_URL must be set when DB_DRIVER=postgres');
  }
  const raw = new Pool({ connectionString: url });
  const db = pgDrizzle(raw, { schema: pgTables });
  return { db, driver, raw };
}

let cached: DbHandle | null = null;

/** Process-wide handle, created lazily from env on first access. */
export function getDb(): DbHandle {
  if (!cached) cached = createDb();
  return cached;
}

/** Apply pending sqlite migrations to a better-sqlite3 handle (idempotent). */
export { migrateSqlite as migrate };
