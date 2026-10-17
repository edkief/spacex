/**
 * Fastify application factory.
 *
 * Exposes a single `buildApp(config)` entry point so tests can `inject()`
 * requests without binding a TCP port. The full route table will grow with
 * subsequent tasks.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { registerCallsignRoutes } from "./routes/callsigns.js";
import type { Repository } from "./db/repo.js";

export interface BuildAppOptions {
  /** Disable Fastify's startup logger (useful in tests). */
  quietLogger?: boolean;
  /**
   * Repository used to wire the callsign + session routes. When omitted,
   * the server omits the auth routes so the smoke-only mode stays cheap.
   */
  repo?: Repository;
  /** SESSION_SECRET — needed when `repo` is provided. */
  sessionSecret?: string;
  /** Galaxy seed (TASK-3) — needed when `repo` is provided. */
  galaxySeed?: string;
  /** Galaxy size (number of stars) — needed when `repo` is provided. */
  galaxyStarCount?: number;
  /** Override the wall clock for tests (epoch ms). */
  nowMs?: number;
}

/**
 * Construct a Fastify instance with the Drift baseline:
 *  - JSON body parser enabled (consumed by future REST handlers).
 *  - `/api/health` route returning `{ ok: true, galaxySeed }`.
 *  - `/api/callsigns` and `/api/session` (TASK-10, when a repo is supplied).
 *
 * The function is intentionally side-effect free: it does NOT call
 * `app.listen()`. The entrypoint (`src/server/index.ts`) is responsible
 * for binding to a TCP port.
 */
export async function buildApp(
  config: ServerConfig,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.quietLogger ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });

  app.get("/api/health", async () => ({
    ok: true,
    galaxySeed: config.galaxySeed,
  }));

  if (options.repo && options.sessionSecret && options.galaxySeed) {
    registerCallsignRoutes(app, {
      repo: options.repo,
      sessionSecret: options.sessionSecret,
      claimDefaults: {
        galaxySeed: options.galaxySeed,
        galaxyStarCount: options.galaxyStarCount ?? 32,
        nowMs: options.nowMs,
      },
    });
  }

  return app;
}
