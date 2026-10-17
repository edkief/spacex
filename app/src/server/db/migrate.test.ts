/**
 * Migration runner tests (TASK-62 AC3).
 *
 * Verifies that `migrateSqlite()` is idempotent across process restarts and
 * that the bookkeeping table survives multiple invocations. We exercise
 * the function against an in-memory better-sqlite3 handle so the test
 * stays isolated from the running dev/prod database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { migrateSqlite } from "./migrate.js";

let handles: BetterSqlite3.Database[] = [];

function newDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  handles.push(db);
  return db;
}

beforeEach(() => {
  handles = [];
});

afterEach(() => {
  for (const h of handles) h.close();
  handles = [];
});

describe("migrateSqlite()", () => {
  it("applies all migrations on a fresh DB and reports applied filenames", () => {
    const db = newDb();
    const result = migrateSqlite(db);
    expect(result.applied).toContain("0001_init.sql");
    expect(result.skipped).toEqual([]);
  });

  it("is idempotent: re-running marks every file as skipped", () => {
    const db = newDb();
    migrateSqlite(db);
    const second = migrateSqlite(db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain("0001_init.sql");
  });

  it("creates every table and index PRD §8 requires", () => {
    const db = newDb();
    migrateSqlite(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "players",
        "ships",
        "cargo_items",
        "sessions",
        "resource_node_state",
        "system_registry",
        "_drift_migrations",
        "players_callsign_unique",
        "ships_owner_id_idx",
        "cargo_items_ship_resource_unique",
        "cargo_items_ship_id_idx",
        "sessions_player_id_idx",
        "sessions_expires_at_idx",
        "resource_node_state_system_id_idx",
      ]),
    );
  });

  it("rejects duplicate callsigns at the DB level (sanity of UNIQUE index)", () => {
    const db = newDb();
    migrateSqlite(db);
    db.prepare("INSERT INTO players (id, callsign) VALUES (?, ?)").run("p1", "TEST-DUP");
    expect(() =>
      db.prepare("INSERT INTO players (id, callsign) VALUES (?, ?)").run("p2", "TEST-DUP"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("rejects invalid ship state via CHECK constraint", () => {
    const db = newDb();
    migrateSqlite(db);
    db.prepare("INSERT INTO players (id, callsign) VALUES (?, ?)").run("p1", "X");
    // The CHECK constraint is enforced by SQLite; an invalid state value
    // bubbles up as a SqliteError on insert.
    expect(() =>
      db
        .prepare(
          "INSERT INTO ships (id, owner_id, class_id, livery, hull, shields, position, velocity, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("s1", "p1", "scout", "{}", 100, 100, "{}", "{}", "INVALID_STATE"),
    ).toThrow(/CHECK constraint failed/);
  });
});
