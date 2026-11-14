import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { pgTables } from './schema.pg.ts';
import { tables, type Tables } from './schema.ts';

export type Dialect = 'sqlite' | 'postgres';

/**
 * The query-builder type the repositories are written against. It is the SQLite builder; the
 * Postgres builders expose the same fluent API and are cast to it once, in `makePgHandle`. The
 * repository suite runs against real SQLite and real Postgres (PGlite) to keep that honest.
 */
export type Db = BetterSQLite3Database;

/** An open database: dialect-specific tables, serialised access and lifecycle. */
export interface DbHandle {
  readonly dialect: Dialect;
  readonly tables: Tables;
  /** Runs `fn` as one unit of access (SQLite: serialised on the single connection). */
  run<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Runs `fn` in a transaction; commits on resolve, rolls back on reject. */
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Takes a row lock on a player where the dialect needs one (Postgres); no-op on SQLite. */
  lockPlayer(db: Db, playerId: string): Promise<void>;
  /** SQL expression extracting a top-level text key from a JSON column. */
  jsonText(column: unknown, key: string): ReturnType<typeof sql>;
  migrate(migrationsFolder: string): Promise<void>;
  close(): Promise<void>;
}

export interface SqliteOptions {
  /** SQLite file path (or ':memory:'); parent directories are created. */
  file: string;
}

/**
 * Opens a SQLite database with WAL journaling, foreign keys on and a busy timeout.
 * synchronous=NORMAL is crash-safe against process kills (kill -9); only an OS crash or power
 * loss can drop the most recent commits.
 */
export function openSqlite({ file }: SqliteOptions): DbHandle {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzleSqlite(sqlite);

  // One connection: serialise every unit of access so an open transaction is never interleaved
  // with another caller's statements between awaits.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    dialect: 'sqlite',
    tables,
    run: (fn) => exclusive(() => fn(db)),
    transaction: (fn) =>
      exclusive(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(db);
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
          throw error;
        }
      }),
    lockPlayer: () => Promise.resolve(),
    jsonText: (column, key) => sql`json_extract(${column}, ${`$.${key}`})`,
    migrate: (folder) => {
      migrateSqlite(db, { migrationsFolder: folder });
      return Promise.resolve();
    },
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  };
}

/** What a Drizzle Postgres database offers that the shared repositories rely on. */
export interface PgLikeDb {
  transaction<T>(fn: (tx: PgLikeDb) => Promise<T>): Promise<T>;
  execute(query: unknown): Promise<unknown>;
}

/**
 * Wraps any Drizzle Postgres database (node-postgres, PGlite) as a DbHandle. `db` is cast to
 * the SQLite builder type once here; see the note on `Db`.
 */
export function makePgHandle(
  db: PgLikeDb,
  migrateFn: (folder: string) => Promise<void>,
  close: () => Promise<void>,
): DbHandle {
  const asDb = (value: PgLikeDb): Db => value as unknown as Db;
  return {
    dialect: 'postgres',
    tables: pgTables as unknown as Tables,
    run: (fn) => fn(asDb(db)),
    transaction: (fn) => db.transaction((tx) => fn(asDb(tx))),
    lockPlayer: async (tx, playerId) => {
      await (tx as unknown as PgLikeDb).execute(
        sql`select 1 from players where id = ${playerId} for update`,
      );
    },
    jsonText: (column, key) => sql`${column} ->> ${key}`,
    migrate: migrateFn,
    close,
  };
}

/** Opens a Postgres database through a node-postgres pool. */
export function openPostgres(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString });
  const db = drizzlePg(pool);
  return makePgHandle(
    db,
    (folder) => migratePg(db, { migrationsFolder: folder }),
    () => pool.end(),
  );
}
