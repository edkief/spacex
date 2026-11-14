import { defineConfig } from 'drizzle-kit';

// Generates SQLite migrations: npm run db:generate
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema.ts',
  out: './drizzle/sqlite',
});
