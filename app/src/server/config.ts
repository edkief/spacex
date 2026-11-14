import { z } from 'zod';
import type { EnvSource } from './env.ts';

export const SESSION_SECRET_PLACEHOLDER = 'TODO_FILL_MANUALLY';
const MIN_SECRET_LENGTH = 32;

const portSchema = z.coerce.number().int().min(1).max(65535);

const sessionSecretSchema = z
  .string({ error: 'is required (set it in PROJECT_ROOT/.env.local)' })
  .min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`)
  .refine((value) => !value.includes(SESSION_SECRET_PLACEHOLDER), {
    error: `still holds the ${SESSION_SECRET_PLACEHOLDER} placeholder; fill in a real secret`,
  });

const envObject = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: portSchema.default(3000),
  API_PORT: portSchema.optional(),
  SESSION_SECRET: sessionSecretSchema,
  GALAXY_SEED: z.string().min(1).default('drift-default-galaxy'),
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DB_PATH: z.string().min(1).default('./data/drift.db'),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// or postgresql:// URL')
    .optional(),
  SYSTEM_INSTANCE_COUNT: z.coerce.number().int().min(1).max(64).default(3),
  WS_PATH: z
    .string()
    .regex(/^\/[^\s?#]*$/, 'must be an absolute path such as /ws')
    .default('/ws'),
});

const envSchema = envObject.superRefine((env, ctx) => {
  if (env.DB_DRIVER === 'postgres' && !env.DATABASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'is required when DB_DRIVER=postgres',
    });
  }
});

/** Fully validated server configuration. */
export interface ServerConfig {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  host: string;
  /** Public port: Vite in dev, the Node server in production. */
  port: number;
  /** Port the Node server listens on in dev (Vite proxies to it). Defaults to PORT + 1. */
  apiPort: number;
  /** The port this process should actually bind: `port` in production, `apiPort` otherwise. */
  listenPort: number;
  sessionSecret: string;
  galaxySeed: string;
  dbDriver: 'sqlite' | 'postgres';
  dbPath: string;
  /** Postgres connection string; required only when dbDriver is 'postgres'. Never log it. */
  databaseUrl: string | undefined;
  systemInstanceCount: number;
  wsPath: string;
}

/** Endpoint subset needed by tooling (Vite, Playwright) that must not require SESSION_SECRET. */
export type EndpointConfig = Pick<ServerConfig, 'host' | 'port' | 'apiPort' | 'wsPath'>;

/** Thrown when the environment is invalid. Messages name variables, never their values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Drops empty/whitespace-only values so `FOO=` in a dotenv file counts as unset. */
function normalise(env: EnvSource): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== '',
  );
  return Object.fromEntries(entries);
}

/** Formats zod issues as `VAR: message` lines using only the variable name and our own text. */
function describeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => `${issue.path.map(String).join('.') || 'env'}: ${issue.message}`);
}

/**
 * Validates an env object into a typed config. A pure function of its input: tests pass their
 * own env and never touch the real .env.local.
 * @throws ConfigError naming each invalid variable (never its value).
 */
export function loadConfig(env: EnvSource): ServerConfig {
  const result = envSchema.safeParse(normalise(env));
  if (!result.success) throw new ConfigError(describeIssues(result.error.issues));
  const parsed = result.data;
  const apiPort = parsed.API_PORT ?? parsed.PORT + 1;
  if (apiPort > 65535) throw new ConfigError(['API_PORT: derived value exceeds 65535; set it']);
  if (apiPort === parsed.PORT) throw new ConfigError(['API_PORT: must differ from PORT']);
  const isProduction = parsed.NODE_ENV === 'production';
  return {
    nodeEnv: parsed.NODE_ENV,
    isProduction,
    host: parsed.HOST,
    port: parsed.PORT,
    apiPort,
    listenPort: isProduction ? parsed.PORT : apiPort,
    sessionSecret: parsed.SESSION_SECRET,
    galaxySeed: parsed.GALAXY_SEED,
    dbDriver: parsed.DB_DRIVER,
    dbPath: parsed.DB_PATH,
    databaseUrl: parsed.DATABASE_URL,
    systemInstanceCount: parsed.SYSTEM_INSTANCE_COUNT,
    wsPath: parsed.WS_PATH,
  };
}

/**
 * Resolves host/ports/WS path without requiring a session secret, for Vite and Playwright
 * configs. Uses a placeholder-free dummy secret internally so only endpoint errors can surface.
 */
export function loadEndpointConfig(env: EnvSource): EndpointConfig {
  const dummySecret = 'x'.repeat(MIN_SECRET_LENGTH);
  const { host, port, apiPort, wsPath } = loadConfig({
    ...env,
    SESSION_SECRET: dummySecret,
    DB_DRIVER: 'sqlite',
  });
  return { host, port, apiPort, wsPath };
}
