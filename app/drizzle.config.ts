import { defineConfig } from 'drizzle-kit';

// Dialect/out can be overridden via env so CI can run the Postgres parity
// check (drizzle-kit generate --dialect postgresql) against a temp dir.
export default defineConfig({
  dialect: process.env.DRIZZLE_DIALECT === 'sqlite' ? 'sqlite' : 'postgresql',
  schema: './src/server/db/schema.ts',
  out: process.env.DRIZZLE_OUT ?? './drizzle-pg',
});
