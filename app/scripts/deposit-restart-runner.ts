/**
 * Deposit persistence restart runner (TASK-37 acceptance).
 *
 * Standalone helper invoked by
 * `src/server/db/repo.deposits.restart.test.ts`. Opens a SQLite
 * database at the path passed via `process.argv[2]`, writes a
 * deposit-state row, then `process.exit(0)`. The parent test
 * re-opens the file and asserts the row reads back with the
 * depleted `remaining` value.
 *
 * Why a child process: better-sqlite3 + WAL guarantee that
 * committed statements survive a process exit, but writing +
 * reading from the same vitest worker doesn't actually exercise
 * that — auto-commit happens regardless. Spawning a real OS
 * process and re-opening the file is the only honest round-trip
 * test for "persist across a restart".
 *
 * Env vars:
 *   - DB_PATH               SQLite file path (positional, required).
 *   - DEPOSIT_STAR_ID       star id to use (default a known seed id).
 *   - DEPOSIT_SEQ           deposit seq (default 0).
 *   - DEPOSIT_REMAINING     value to persist (default 25).
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateSqlite } from "../src/server/db/migrate.js";
import { createSqliteRepository } from "../src/server/db/repo.sqlite.js";
import { sqliteSchema } from "../src/server/db/schema.sqlite.js";
import { depositsForSimple } from "../src/shared/world/deposits.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    process.stderr.write("usage: deposit-restart-runner.ts <db_path>\n");
    process.exit(2);
  }
  const dbPath = path.resolve(HERE, args[0]!);
  const starId = process.env["DEPOSIT_STAR_ID"] ?? "010203040506070e";
  const depositSeq = Number(process.env["DEPOSIT_SEQ"] ?? "0");
  const remaining = Number(process.env["DEPOSIT_REMAINING"] ?? "25");

  const deposits = depositsForSimple("drift-dev-seed-001", starId);
  const target = deposits[depositSeq];
  if (!target) {
    process.stderr.write(
      `deposit-restart-runner: no deposit at index ${depositSeq} for star ${starId}\n`,
    );
    process.exit(3);
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const handle = new BetterSqlite3(dbPath);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  migrateSqlite(handle);
  const db = drizzle(handle, { schema: sqliteSchema });
  const repo = createSqliteRepository(db);
  try {
    await repo.upsertDepositState({
      id: target.depositId,
      systemId: starId,
      planetId: target.planetId,
      pos: target.pos,
      resourceId: target.resourceId,
      remaining,
      discovered: false,
      depositSeq,
    });
  } finally {
    handle.close();
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
