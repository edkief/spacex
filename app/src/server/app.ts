import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildHealth } from '@shared/health';
import type { Authenticator } from './auth/types.ts';
import type { ServerConfig } from './config.ts';
import type { SystemDirectory } from './directory.ts';
import { REST_BODY_LIMIT, installErrorHandlers } from './rest.ts';
import { realTimers, type Timers } from './timers.ts';
import { attachWebSocket, type WebSocketLayer } from './ws/index.ts';

/** Everything the server needs, injected so tests can substitute any piece. */
export interface ServerDeps {
  config: ServerConfig;
  authenticator: Authenticator;
  directory: SystemDirectory;
  /** Epoch milliseconds (default: Date.now). */
  clock?: () => number;
  timers?: Timers;
}

/** Optional extras that are not dependencies. */
export interface BuildServerOptions {
  /** Directory of the built client to serve (production only). Skipped if it does not exist. */
  staticDir?: string;
  /** Overrides the default logger level (tests use 'silent'). */
  logLevel?: string;
}

export type DriftServer = FastifyInstance & { sockets: WebSocketLayer };

/**
 * Builds the Fastify app (REST + WebSocket) without listening, so tests can use `inject()` or
 * bind an ephemeral port. `index.ts` is the only place that calls `listen`.
 */
export function buildServer(deps: ServerDeps, options: BuildServerOptions = {}): DriftServer {
  const { config } = deps;
  const app = Fastify({
    bodyLimit: REST_BODY_LIMIT,
    logger: { level: options.logLevel ?? (config.nodeEnv === 'test' ? 'silent' : 'info') },
  });

  installErrorHandlers(app);

  app.get('/api/health', () => buildHealth(config.galaxySeed));

  const sockets = attachWebSocket(app, {
    config,
    authenticator: deps.authenticator,
    directory: deps.directory,
    clock: deps.clock ?? ((): number => Date.now()),
    timers: deps.timers ?? realTimers,
    log: app.log,
  });

  if (options.staticDir && existsSync(options.staticDir)) {
    void app.register(fastifyStatic, { root: options.staticDir });
  }

  return Object.assign(app, { sockets });
}
