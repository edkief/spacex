/**
 * Fastify application factory.
 *
 * Exposes a single `buildApp(config)` entry point so tests can `inject()`
 * requests without binding a TCP port. The full route table will grow with
 * subsequent tasks; the only handler that exists today is the `/api/health`
 * smoke check required by TASK-68.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";

export interface BuildAppOptions {
  /** Disable Fastify's startup logger (useful in tests). */
  quietLogger?: boolean;
}

/**
 * Construct a Fastify instance with the Drift baseline:
 *  - JSON body parser enabled (consumed by future REST handlers).
 *  - `/api/health` route returning `{ ok: true, galaxySeed }`.
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

  return app;
}
