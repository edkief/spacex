/**
 * Driver-aware database client for Drift.
 *
 * Reads `DB_DRIVER` from the environment (default `sqlite`) and returns a
 * configured Drizzle query builder plus a `migrate()` function that is a
 * no-op for Postgres (Drizzle's bundled migrator handles that path
 * separately) and runs the hand-written SQL migrations for SQLite.
 *
 * Two usage patterns:
 *
 *   - **Server boot** (`src/server/index.ts`):
 *     ```ts
 *     const { db, migrate } = createDbClient(loadConfig());
 *     migrate(); // apply pending SQLite migrations; pg = no-op
 *     ```
 *
 *   - **Tests** (vitest): call `createSqliteTestDb()` to get a fresh
 *     in-memory database with the schema already applied.
 *
 * @see ./repo.ts for the repository that consumes `db`.
 */
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool as PgPool } from "pg";
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { serverConfig, type ServerConfig } from "../config.js";
import { migrateSqlite } from "./migrate.js";
import { sqliteSchema } from "./schema.sqlite.js";
import { pgSchema } from "./schema.pg.js";
import { CallsignTakenError } from "./errors.js";

/** Public return type for the active driver. */
export type DbClient =
  | {
      driver: "sqlite";
      db: BetterSQLite3Database<typeof sqliteSchema>;
      sqliteHandle: BetterSqlite3.Database;
      migrate: () => void;
      close: () => void;
    }
  | {
      driver: "postgres";
      db: NodePgDatabase<typeof pgSchema>;
      pgPool: PgPool;
      migrate: () => void;
      close: () => Promise<void>;
    };

/**
 * Create a database client matching the active `DB_DRIVER`.
 *
 * SQLite path:
 *   - Resolves `DB_PATH`, ensuring the directory exists.
 *   - Opens the file with `better-sqlite3`.
 *   - Applies pending migrations synchronously.
 *   - Wraps everything in a Drizzle query builder typed against the SQLite
 *     schema bundle.
 *
 * Postgres path:
 *   - Opens a `pg.Pool` against `DATABASE_URL` (or, when `DB_DRIVER=postgres`
 *     and no DB_PATH, falls back to `DB_PATH` if it looks like a URL).
 *   - Returns a `migrate()` no-op (Drizzle's pg migrator is invoked by the
 *     operator during deploy — TASK-1 user-approved gap documents that we
 *     do not exercise a live PG instance in this sandbox).
 */
export function createDbClient(config: ServerConfig = serverConfig): DbClient {
  if (config.dbDriver === "postgres") {
    return createPostgresClient(config);
  }
  return createSqliteClient(config);
}

/**
 * SQLite-specific factory.
 *
 * Exposed independently of `createDbClient()` so tests can spin up many
 * independent in-memory databases in parallel.
 */
export function createSqliteClient(config: ServerConfig): Extract<DbClient, { driver: "sqlite" }> {
  const dbPath = resolveDbPath(config.dbPath);
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqliteHandle = new BetterSqlite3(dbPath);
  // Foreign keys are needed for cascade delete on ships → cargo_items.
  sqliteHandle.pragma("journal_mode = WAL");
  sqliteHandle.pragma("foreign_keys = ON");
  const db = drizzle(sqliteHandle, { schema: sqliteSchema });
  const migrate = (): void => {
    migrateSqlite(sqliteHandle);
  };
  return {
    driver: "sqlite",
    db,
    sqliteHandle,
    migrate,
    close: () => sqliteHandle.close(),
  };
}

/**
 * Postgres-specific factory. Requires `DATABASE_URL` to be set.
 */
export function createPostgresClient(
  _config: ServerConfig,
): Extract<DbClient, { driver: "postgres" }> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DB_DRIVER=postgres requires DATABASE_URL to be set (see .env.local placeholder).",
    );
  }
  const pgPool = new PgPool({ connectionString: url });
  const db = drizzlePg(pgPool, { schema: pgSchema });
  return {
    driver: "postgres",
    db,
    pgPool,
    migrate: () => {
      // Postgres migrations are operator-driven (out of scope for sandbox).
    },
    close: async () => {
      await pgPool.end();
    },
  };
}

/**
 * Test convenience: open a fresh in-memory SQLite database with migrations
 * already applied, ready to be wrapped in a Drizzle query builder.
 */
export function createSqliteTestDb(): {
  db: BetterSQLite3Database<typeof sqliteSchema>;
  sqliteHandle: BetterSqlite3.Database;
  close: () => void;
} {
  const handle = new BetterSqlite3(":memory:");
  handle.pragma("foreign_keys = ON");
  migrateSqlite(handle);
  const db = drizzle(handle, { schema: sqliteSchema });
  return { db, sqliteHandle: handle, close: () => handle.close() };
}

/**
 * Translate a low-level driver error into a typed business error when the
 * cause is unambiguously mappable. Currently handles:
 *   - SQLite UNIQUE constraint on `players.callsign` → `CallsignTakenError`.
 *
 * Called by the repository after a caught driver exception; pass-through
 * unknown errors to the caller.
 */
export function mapDriverError(err: unknown): unknown {
  if (err instanceof CallsignTakenError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  // SQLite-driver message — format is "<table>.<index> UNIQUE constraint failed"
  if (/UNIQUE constraint failed/i.test(msg)) {
    if (/players\.callsign_unique/i.test(msg) || /players\.callsign/i.test(msg)) {
      return new CallsignTakenError("(callsign captured by index name)");
    }
    return err;
  }
  return err;
}

/**
 * Resolve the SQLite DB path. Relative paths are resolved against `cwd`;
 * `":memory:"` is treated literally.
 */
function resolveDbPath(input: string): string {
  if (input === ":memory:") return ":memory:";
  if (path.isAbsolute(input)) return input;
  return path.resolve(process.cwd(), input);
}
