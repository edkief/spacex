import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { Env } from '@server/env';

/**
 * Builds the Fastify instance without listening. Tests use inject()
 * against this; the process entrypoint (index.ts) listens and attaches ws.
 * The optional loggerInstance is the log-sink hook (TASK-66): tests pass a
 * pino instance with a capture stream to prove secrets/tokens never reach
 * the logs (fastify v5 rejects logger instances passed as `logger`). The
 * default stays logging-off, as before.
 */
export function buildServer(env: Env, opts: { loggerInstance?: FastifyBaseLogger } = {}) {
  const app = Fastify({
    logger: false,
    ...(opts.loggerInstance ? { loggerInstance: opts.loggerInstance } : {}),
  });

  app.get('/api/health', async () => ({
    ok: true,
    galaxySeed: env.GALAXY_SEED,
  }));

  return app;
}
