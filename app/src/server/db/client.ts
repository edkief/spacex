import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { createSchema, Driver } from './schema';

let DB_DRIVER = (process.env.DB_DRIVER || 'sqlite') as Driver;
let DB_PATH = process.env.DB_PATH || 'db.sqlite';
let DATABASE_URL = process.env.DATABASE_URL;

let _dbInstance: any;
let _sqliteDb: any = null;

export function initDb() {
  DB_DRIVER = (process.env.DB_DRIVER || 'sqlite') as Driver;
  DB_PATH = process.env.DB_PATH || 'db.sqlite';
  DATABASE_URL = process.env.DATABASE_URL;

  if (DB_DRIVER === 'sqlite') {
    if (_sqliteDb) _sqliteDb.close();
    _sqliteDb = new Database(DB_PATH);
    _sqliteDb.pragma('journal_mode = WAL');
    _dbInstance = drizzle(_sqliteDb, { schema: createSchema(DB_DRIVER) });
  } else {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is required for postgres driver');
    }
    const pool = new Pool({
      connectionString: DATABASE_URL,
    });
    _dbInstance = drizzlePg(pool, { schema: createSchema(DB_DRIVER) });
  }
  return _dbInstance;
}

export const db = new Proxy({} as any, {
  get: (_, prop) => {
    if (!_dbInstance) initDb();
    return (_dbInstance as any)[prop];
  },
});

export const schema = createSchema(DB_DRIVER);

export async function migrate() {
  if (DB_DRIVER !== 'sqlite') {
    console.log('Postgres migrations: handled externally via drizzle-kit');
    return;
  }

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log('No migrations directory found, skipping SQLite migrations');
    return;
  }

  const sqliteDb = new Database(DB_PATH);

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedMigrations = sqliteDb.prepare('SELECT name FROM _migrations').all() as {
    name: string;
  }[];
  const appliedNames = new Set(appliedMigrations.map((m) => m.name));

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    if (!appliedNames.has(file)) {
      console.log(`Applying migration: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      sqliteDb.transaction(() => {
        sqliteDb.exec(sql);
        sqliteDb.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      })();
    }
  }
  sqliteDb.close();
}
