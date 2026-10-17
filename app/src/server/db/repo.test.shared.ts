/**
 * Test harness shared by every `*.test.ts` file under `./db/`.
 *
 * Each test gets a fresh in-memory SQLite database with migrations
 * applied (`createSqliteTestDb()`). The harness wraps the DB and the
 * repository in a single object so suites can be written as flat arrays
 * of `it()` blocks without per-fixture setup ceremony.
 */
import { afterEach, beforeEach } from "vitest";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { createSqliteTestDb } from "./client.js";
import { createSqliteRepository } from "./repo.sqlite.js";
import type { Repository } from "./repo.js";
import { type sqliteSchema } from "./schema.sqlite.js";

/** A single per-test handle: DB + repository + close callback. */
export interface RepoHarness {
  repo: Repository;
  db: BetterSQLite3Database<typeof sqliteSchema>;
  close: () => void;
}

/** Build a fresh harness for one test. */
export function newRepoHarness(): RepoHarness {
  const { db, close } = createSqliteTestDb();
  return { repo: createSqliteRepository(db), db, close };
}

/**
 * Standard vitest hook pair — call from inside `describe(...)`. The active
 * harness lives on a closure-scoped variable so each test sees its own.
 */
const SUITE_STATE = Symbol.for("@drift/repo-suite-state");

interface SuiteState {
  current: RepoHarness | null;
}

// Use a single module-scoped state object so `beforeEach` and
// `afterEach` (each imported separately per file) share it.
const g = globalThis as unknown as { [SUITE_STATE]?: SuiteState };
if (!g[SUITE_STATE]) {
  g[SUITE_STATE] = { current: null };
}
const state = g[SUITE_STATE]!;

/** Returns the active harness inside an `it()` block. */
export function active(): RepoHarness {
  if (!state.current) {
    throw new Error(
      `active(): call newRepoHarness() before each test (did you import the beforeEach hook?)`,
    );
  }
  return state.current;
}

/** Standard vitest hooks — `import { installRepoHooks } from "./repo.test.shared.ts"`. */
export function installRepoHooks(): void {
  beforeEach(() => {
    state.current = newRepoHarness();
  });
  afterEach(() => {
    state.current?.close();
    state.current = null;
  });
}
