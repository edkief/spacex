import { defineConfig } from 'drizzle-kit';

// Generates Postgres migrations (no live database needed): npm run db:generate
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.pg.ts',
  out: './drizzle/pg',
});
