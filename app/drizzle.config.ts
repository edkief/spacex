/**
 * Drizzle-Kit configuration for the Postgres driver.
 *
 * Operator use (out of scope for the sandbox; live PG validation is
 * a TASK-1 user-approved gap and lands post-v1):
 *
 *     DB_DRIVER=postgres DATABASE_URL=... \
 *       npx drizzle-kit generate --config drizzle.config.ts
 *
 * The CI parity test (`src/server/db/pg.parity.test.ts`) builds its own
 * minimal config in a tmp directory so it doesn't depend on this file —
 * keeping the operator workflow and the test pipeline cleanly separated.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/db/schema.pg.ts",
  out: "./drizzle",
  dialect: "postgresql",
});
