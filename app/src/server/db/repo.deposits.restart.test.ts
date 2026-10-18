/**
 * Deposit persistence restart test — TASK-37.
 *
 * Real child-process crash + reload round-trip. Mirrors the
 * TASK-24 + TASK-63 crash-test pattern: spawn a fresh `tsx`
 * process that opens a SQLite file at a temp path, writes a
 * deposit-state row, and exits. The parent test then re-opens
 * the same file and asserts the row reads back with the depleted
 * `remaining`.
 *
 * Why a child process: better-sqlite3 + WAL guarantee committed
 * statements survive a process exit, but writing + reading from
 * the same vitest worker doesn't actually exercise that —
 * auto-commit happens regardless. Spawning a real OS process and
 * re-opening the file is the only honest round-trip test.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { migrateSqlite } from "./migrate.js";
import { sqliteSchema } from "./schema.sqlite.js";
import { createSqliteRepository } from "./repo.sqlite.js";
import { depositsForSimple } from "@shared/world/deposits.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "../../..");
const TSX_BIN = path.join(APP_ROOT, "node_modules/.bin/tsx");
const RUNNER = path.join(APP_ROOT, "scripts/deposit-restart-runner.ts");

let tmpDir: string | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "drift-deposit-restart-"));
});

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("deposit state — restart persistence (child process)", () => {
  it("a mined deposit's `remaining` survives a process restart", () => {
    if (!tmpDir) throw new Error("tmpDir not initialised");
    const dbPath = path.join(tmpDir, "deposit.db");
    const starId = "010203040506070e";
    const depositSeq = 3;
    const initialAmount = depositsForSimple("drift-dev-seed-001", starId)[depositSeq]!.amount;
    const mineAmount = 7;
    const expectedRemaining = initialAmount - mineAmount;

    // Spawn the runner that opens the DB, writes the row, and exits.
    const result = spawnSync(TSX_BIN, [RUNNER, dbPath], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        DEPOSIT_STAR_ID: starId,
        DEPOSIT_SEQ: String(depositSeq),
        DEPOSIT_REMAINING: String(expectedRemaining),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `deposit-restart-runner failed (status=${result.status}):\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      );
    }

    // Re-open the file from a fresh process and assert the row.
    return (async () => {
      const handle = new BetterSqlite3(dbPath);
      handle.pragma("journal_mode = WAL");
      handle.pragma("foreign_keys = ON");
      migrateSqlite(handle);
      const db = drizzle(handle, { schema: sqliteSchema });
      const repo = createSqliteRepository(db);
      try {
        const rows = await repo.listDepositStates(starId);
        expect(rows.length).toBe(1);
        const row = rows[0]!;
        expect(row.remaining).toBe(expectedRemaining);
        expect(row.id).toBe(depositsForSimple("drift-dev-seed-001", starId)[depositSeq]!.depositId);
        expect(row.systemId).toBe(starId);
        expect(row.depositSeq).toBe(depositSeq);
        expect(row.discovered).toBe(false);
        // The initial amount from the seed minus the mine amount
        // must equal the persisted `remaining`.
        expect(row.remaining).toBe(initialAmount - mineAmount);
      } finally {
        handle.close();
      }
    })();
  });

  it("discovery flag flips survive a process restart", () => {
    if (!tmpDir) throw new Error("tmpDir not initialised");
    const dbPath = path.join(tmpDir, "deposit.db");
    const starId = "010203040506070f";
    const depositSeq = 5;

    const writeResult = spawnSync(TSX_BIN, [RUNNER, dbPath], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        DEPOSIT_STAR_ID: starId,
        DEPOSIT_SEQ: String(depositSeq),
        DEPOSIT_REMAINING: "12",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (writeResult.status !== 0) {
      throw new Error(
        `deposit-restart-runner failed (status=${writeResult.status}):\nstdout=${writeResult.stdout}\nstderr=${writeResult.stderr}`,
      );
    }

    // Re-open + flip discovered, then re-restart to verify the flag persists.
    const handle = new BetterSqlite3(dbPath);
    handle.pragma("journal_mode = WAL");
    handle.pragma("foreign_keys = ON");
    migrateSqlite(handle);
    const db = drizzle(handle, { schema: sqliteSchema });
    const repo = createSqliteRepository(db);
    return (async () => {
      const target = depositsForSimple("drift-dev-seed-001", starId)[depositSeq]!;
      await repo.upsertDepositState({
        id: target.depositId,
        systemId: starId,
        planetId: target.planetId,
        pos: target.pos,
        resourceId: target.resourceId,
        remaining: 12,
        discovered: true,
        depositSeq,
      });
      handle.close();

      // Second restart: re-open + verify.
      const reopen = new BetterSqlite3(dbPath);
      reopen.pragma("journal_mode = WAL");
      reopen.pragma("foreign_keys = ON");
      migrateSqlite(reopen);
      const reopenDb = drizzle(reopen, { schema: sqliteSchema });
      const reopenRepo = createSqliteRepository(reopenDb);
      try {
        const rows = await reopenRepo.listDepositStates(starId);
        expect(rows.length).toBe(1);
        expect(rows[0]?.discovered).toBe(true);
        expect(rows[0]?.remaining).toBe(12);
      } finally {
        reopen.close();
      }
    })();
  });
});
