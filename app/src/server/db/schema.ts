/**
 * Schema entry point — drives the rest of the server from `DB_DRIVER`.
 *
 * Both schemas export the same logical table names (`players`, `ships`,
 * `cargoItems`, …) so the repository code is driver-agnostic. The
 * `selectSchemaFor()` helper picks the bundle matching the active driver.
 *
 * We deliberately re-export *both* bundles (`sqliteSchema`, `pgSchema`) so
 * the Postgres compile-parity test (TASK-62 AC3) can import and instantiate
 * the pg schema without first flipping `DB_DRIVER`.
 */
import { sqliteSchema, type SqliteSchema } from "./schema.sqlite.js";
import { pgSchema, type PgSchema } from "./schema.pg.js";

export { sqliteSchema } from "./schema.sqlite.js";
export { pgSchema } from "./schema.pg.js";
export type { SqliteSchema } from "./schema.sqlite.js";
export type { PgSchema } from "./schema.pg.js";

/** Discriminated union of the two schema bundles. */
export type AnyDriftSchema = SqliteSchema | PgSchema;

/**
 * Pick the schema bundle matching the active driver.
 *
 * The driver is detected from `ServerConfig.dbDriver`; tests flip this
 * per-fixture rather than mutating module-level state.
 */
export function selectSchemaFor(driver: "sqlite" | "postgres"): AnyDriftSchema {
  if (driver === "postgres") return pgSchema;
  return sqliteSchema;
}
