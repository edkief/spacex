/**
 * Tiny migration runner for the SQLite driver.
 *
 * Drizzle's bundled `migrate(db, config)` lives behind a `drizzle.config.ts`
 * + journal file that's awkward to recreate from a script. For the
 * Drift SQLite boot path we ship hand-written SQL in
 * `migrations/sqlite/*.sql` and apply each file once per process lifetime,
 * bookkeeping via the local `_drift_migrations` table (separate from
 * Drizzle's `__drizzle_migrations` so two runners don't collide).
 *
 * Postgres migrations are out of scope for the sandbox (TASK-1 user-approved
 * gap); the schema-compile parity test (TASK-62 AC3) covers the pg path
 * without needing a live database.
 */
import BetterSqlite3, { type Database as BetterSqlite3Database } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_MIGRATIONS_DIR = path.join(HERE, "migrations", "sqlite");

/**
 * Shape returned by `migrateSqlite()`. The `db` handle is what callers
 * hand to `drizzle()` to get the query builder.
 */
export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every not-yet-applied `.sql` migration under the SQLite migrations
 * directory, in lexicographic order. Idempotent across process restarts.
 *
 * The migration bookkeeping table is created lazily on the first call so
 * callers don't have to pre-create it.
 */
export function migrateSqlite(
  db: BetterSqlite3Database,
  migrationsDir: string = SQLITE_MIGRATIONS_DIR,
): MigrateResult {
  ensureBookkeepingTable(db);

  const already = new Set(
    db
      .prepare("SELECT name FROM _drift_migrations")
      .all()
      .map((row) => (row as { name: string }).name),
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (already.has(file)) {
      skipped.push(file);
      continue;
    }
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sqlText);
      db.prepare("INSERT INTO _drift_migrations (name) VALUES (?)").run(file);
    });
    apply();
    applied.push(file);
  }

  return { applied, skipped };
}

/**
 * Create the `_drift_migrations` bookkeeping table if it doesn't exist.
 * Split out from `migrateSqlite()` so unit tests can use the same path.
 */
function ensureBookkeepingTable(db: BetterSqlite3Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _drift_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )`);
}

/**
 * Re-export the better-sqlite3 constructor so callers only have to import
 * from one place.
 */
export { BetterSqlite3 };
