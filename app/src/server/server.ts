import Fastify from 'fastify';
import type { Env } from '@server/env';

/**
 * Builds the Fastify instance without listening. Tests use inject()
 * against this; the process entrypoint (index.ts) listens and attaches ws.
 */
export function buildServer(env: Env) {
  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({
    ok: true,
    galaxySeed: env.GALAXY_SEED,
  }));

  return app;
}
