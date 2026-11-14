import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildHealth } from '@shared/health';
import type { ServerConfig } from './config.ts';
import { attachWebSocket } from './ws.ts';

/** Optional extras for `buildServer` that are not part of the validated env config. */
export interface BuildServerOptions {
  /** Directory of the built client to serve (production only). Skipped if it does not exist. */
  staticDir?: string;
  /** Overrides the default logger level (tests use 'silent'). */
  logLevel?: string;
}

/**
 * Builds the Fastify app (REST + ws) without listening, so tests can use `inject()` or bind an
 * ephemeral port. `index.ts` is the only place that calls `listen`.
 */
export function buildServer(
  config: ServerConfig,
  options: BuildServerOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? (config.nodeEnv === 'test' ? 'silent' : 'info') },
  });

  app.get('/api/health', () => buildHealth(config.galaxySeed));
  attachWebSocket(app, config.wsPath);

  if (options.staticDir && existsSync(options.staticDir)) {
    void app.register(fastifyStatic, { root: options.staticDir });
  }

  return app;
}
