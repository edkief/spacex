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
  SYSTEM_INSTANCE_COUNT: z.coerce.number().int().positive().default(3),
  WS_PATH: z.string().min(2).startsWith('/').default('/ws'),
});

export type Env = z.infer<typeof schema>;

/** Parsed, validated server environment with defaults applied. */
export function loadEnv(): Env {
  return schema.parse(process.env);
}
