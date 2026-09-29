import fs from 'fs';
import path from 'path';
import type BetterSQLite3 from 'better-sqlite3';

type BetterSQLite3Handle = InstanceType<typeof BetterSQLite3>;

/**
 * Apply `migrations/*.sql` files sequentially to a better-sqlite3 handle.
 * Applied files are recorded in a `_migrations` tracking table; re-running is
 * idempotent. Each file runs inside its own transaction.
 *
 * @returns the number of migration files applied by this call
 */
export function migrateSqlite(
  sqlite: BetterSQLite3Handle,
  migrationsDir: string = path.join(__dirname, 'migrations'),
): number {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set<string>(
    sqlite
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(sqlText);
      sqlite
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
      sqlite.exec('COMMIT');
      appliedCount += 1;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${String(err)}`, { cause: err });
    }
  }
  return appliedCount;
}
