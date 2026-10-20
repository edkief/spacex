/**
 * Server configuration loader.
 *
 * Reads runtime settings from `PROJECT_ROOT/.env.local` via dotenv, applies
 * defaults documented in PRD §7, and exposes a typed `ServerConfig` object
 * that the rest of the server imports.
 *
 * `PROJECT_ROOT` defaults to two levels up from this file (`app/`'s parent).
 * Tests can override it with `process.env.PROJECT_ROOT` before requiring
 * this module.
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the drift workspace root (the directory that holds `.env.local`
 * and the `app/` sub-project). Three levels up from this file:
 *   `app/src/server/config.ts` → `app/` → workspace root.
 */
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? path.resolve(HERE, "..", "..", "..");

// Load `.env.local` from the workspace root. Existing process env wins so
// operators can override per-shell without editing the file.
loadEnv({ path: path.join(PROJECT_ROOT, ".env.local"), override: false });

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number in env: ${value}`);
  }
  return parsed;
};

const str = (value: string | undefined, fallback: string): string => {
  if (value === undefined || value === "") return fallback;
  return value;
};

export interface ServerConfig {
  /** User-facing client port (Vite dev server). Defaults to 3000. */
  port: number;
  /** Port the Fastify server actually listens on. Defaults to `port + 1`. */
  apiPort: number;
  /** Path mounted for the WebSocket upgrade (defaults to `/ws`). */
  wsPath: string;
  /** 64+ char hex used for signing callsign session tokens (TASK-10). */
  sessionSecret: string;
  /** Deterministic seed used to generate the galaxy (TASK-3). */
  galaxySeed: string;
  /** `sqlite` or `postgres`. Default `sqlite` for local dev (PRD §7). */
  dbDriver: "sqlite" | "postgres";
  /** Filesystem path for the SQLite database; Postgres connection string for `postgres`. */
  dbPath: string;
  /** Hard cap on concurrently loaded system shards (TASK-11). */
  systemInstanceCount: number;
  /**
   * Directory holding the built client to serve. Empty in dev, where Vite
   * serves the client; set to the vite `dist/client` output in the
   * production container image so the API process also serves the client.
   */
  staticDir: string;
  /** Absolute path to the project root, exposed for tests and tooling. */
  projectRoot: string;
}

/**
 * Build the typed server config from the current process env.
 *
 * Pure function so unit tests can call `loadConfig()` after mutating
 * `process.env` without leaking state between runs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const driver = str(env.DB_DRIVER, "sqlite");
  if (driver !== "sqlite" && driver !== "postgres") {
    throw new Error(`Unsupported DB_DRIVER: ${driver}`);
  }
  return {
    port: num(env.PORT, 3000),
    apiPort: num(env.API_PORT, num(env.PORT, 3000) + 1),
    wsPath: str(env.WS_PATH, "/ws"),
    sessionSecret: str(env.SESSION_SECRET, ""),
    galaxySeed: str(env.GALAXY_SEED, "DRIFT-SEED-0001"),
    dbDriver: driver,
    dbPath: str(env.DB_PATH, "./data/drift.db"),
    systemInstanceCount: num(env.SYSTEM_INSTANCE_COUNT, 3),
    staticDir: str(env.STATIC_DIR, ""),
    projectRoot: PROJECT_ROOT,
  };
}

/**
 * Cached config singleton used by the live server. Tests should call
 * `loadConfig()` directly so each test gets a fresh snapshot.
 */
export const serverConfig: ServerConfig = loadConfig();
