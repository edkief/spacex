/**
 * Postgres-backed implementation of the Drift repository.
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
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { pgSchema } from "./schema.pg.js";
import { bindPgIdentity } from "./repo.pg.identity.js";
import { bindPgWorld } from "./repo.pg.world.js";
import type { Repository } from "./repo.js";

/**
 * Construct a Postgres-backed `Repository`.
 *
 * Pure factory — no global state. Tests that drive Postgres directly
 * (when one is available, post-v1) build their own `pg.Pool` and pass it
 * in via `drizzle()`.
 */
export function createPgRepository(db: NodePgDatabase<typeof pgSchema>): Repository {
  const identity = bindPgIdentity(db);
  const world = bindPgWorld(db, identity as never);
  return {
    ...identity,
    ...world,
  } as unknown as Repository;
}
