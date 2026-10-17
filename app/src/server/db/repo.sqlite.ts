/**
 * SQLite-backed implementation of the Drift repository.
 *
 * Composes the identity (`players` + `ships` + `cargo`) and world
 * (`credits` + `resource nodes` + `sessions` + `system registry`)
 * sub-bindings into the single `Repository` interface declared in
 * `./repo.ts`.
 *
 * Splitting the implementation across two files mirrors the natural
 * domain boundary — per-player state vs. cross-player world state — and
 * keeps each file under the 200–300 line guideline.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { sqliteSchema } from "./schema.sqlite.js";
import { bindSqliteIdentity } from "./repo.sqlite.identity.js";
import { bindSqliteWorld } from "./repo.sqlite.world.js";
import type { Repository } from "./repo.js";

/**
 * Construct a SQLite-backed `Repository`.
 *
 * Pure factory — no global state, safe to call repeatedly inside the
 * same process (each `createSqliteTestDb()` in tests gets its own).
 */
export function createSqliteRepository(db: BetterSQLite3Database<typeof sqliteSchema>): Repository {
  // Two-phase binding: build a partial repo that exposes the identity
  // methods (player-lookups the world impl needs), then build the world
  // impl with a callback back into the identity impl. The composed
  // object satisfies the full `Repository` interface.
  const identity = bindSqliteIdentity(db);
  const world = bindSqliteWorld(db, identity as never);
  return {
    ...identity,
    ...world,
  } as unknown as Repository;
}
