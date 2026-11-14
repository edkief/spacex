import path from 'node:path';
import type { ServerConfig } from '../config.ts';
import { openPostgres, openSqlite, type DbHandle, type Dialect } from './connection.ts';
import type { ContextDeps } from './context.ts';
import { createRepository, type Repository } from './repo.ts';

export type DbConfig = Pick<ServerConfig, 'dbDriver' | 'dbPath' | 'databaseUrl'>;

export interface OpenOptions extends ContextDeps {
  /** The app directory; relative DB_PATH and the migrations folder resolve against it. */
  appDir: string;
  /** Skip running migrations (tests that migrate explicitly). Defaults to false. */
  skipMigrate?: boolean;
}

export interface OpenedDatabase {
  repo: Repository;
  handle: DbHandle;
  close(): Promise<void>;
}

/** Folder holding the committed, generated migration SQL for a dialect. */
export function migrationsFolder(dialect: Dialect, appDir: string): string {
  return path.join(appDir, 'drizzle', dialect === 'sqlite' ? 'sqlite' : 'pg');
}

/** Resolves DB_PATH against the app directory (never process.cwd()). */
export function resolveDbPath(dbPath: string, appDir: string): string {
  return dbPath === ':memory:' ? dbPath : path.resolve(appDir, dbPath);
}

/**
 * Opens the database chosen by DB_DRIVER (SQLite file or Postgres via DATABASE_URL), applies the
 * committed migrations, and returns the repository. Call `close()` on shutdown.
 */
export async function openDatabase(
  config: DbConfig,
  options: OpenOptions,
): Promise<OpenedDatabase> {
  let handle: DbHandle;
  if (config.dbDriver === 'postgres') {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
    handle = openPostgres(config.databaseUrl);
  } else {
    handle = openSqlite({ file: resolveDbPath(config.dbPath, options.appDir) });
  }
  try {
    if (!options.skipMigrate)
      await handle.migrate(migrationsFolder(handle.dialect, options.appDir));
  } catch (error) {
    await handle.close();
    throw error;
  }
  const { now, newId } = options;
  const repo = createRepository(handle, {
    ...(now ? { now } : {}),
    ...(newId ? { newId } : {}),
  });
  return { repo, handle, close: () => handle.close() };
}
