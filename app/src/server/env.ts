import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// PROJECT_ROOT/.env.local — env vars already set in the process always win
// (dotenv never overrides), which lets dev scripts override PORT etc.
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_SECRET: z.string().min(1).default('insecure-dev-session-secret'),
  GALAXY_SEED: z.string().min(1).default('DRIFT-SEED-0001'),
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DB_PATH: z.string().min(1).default('./data/drift.db'),
  DATABASE_URL: z.string().default(''),
  SYSTEM_INSTANCE_COUNT: z.coerce.number().int().positive().default(3),
  WS_PATH: z.string().min(2).startsWith('/').default('/ws'),
  /** TASK-24: shard flush period (30 s; a hard crash loses up to one period). */
  SHARD_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Built client directory to serve (production image); unset in dev, where vite serves it. */
  STATIC_DIR: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

/** Parsed, validated server environment with defaults applied. */
export function loadEnv(): Env {
  return schema.parse(process.env);
}
