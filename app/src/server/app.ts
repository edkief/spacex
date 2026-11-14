import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildHealth } from '@shared/health';
import { listSpawnSystems, type SpawnSystem } from '@shared/galaxy/spawn.ts';
import { createAuthService } from './auth/service.ts';
import type { Authenticator } from './auth/types.ts';
import type { Repository } from './db/types.ts';
import { registerCallsignRoutes } from './routes/callsigns.ts';
import { registerSessionRoutes } from './routes/session.ts';
import type { ServerConfig } from './config.ts';
import type { SystemDirectory } from './directory.ts';
import { REST_BODY_LIMIT, installErrorHandlers } from './rest.ts';
import { realTimers, type Timers } from './timers.ts';
import { attachWebSocket, type WebSocketLayer } from './ws/index.ts';

/** Everything the server needs, injected so tests can substitute any piece. */
export interface ServerDeps {
  config: ServerConfig;
  repo: Repository;
  /** Overrides the real token authenticator (protocol tests use a stub). */
  authenticator?: Authenticator;
  /** Eligible home systems (default: derived from the configured galaxy seed). */
  spawns?: readonly SpawnSystem[];
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
    trustProxy: config.trustProxy,
    logger: { level: options.logLevel ?? (config.nodeEnv === 'test' ? 'silent' : 'info') },
  });

  installErrorHandlers(app);

  app.get('/api/health', () => buildHealth(config.galaxySeed));

  const clock = deps.clock ?? ((): number => Date.now());
  const auth = createAuthService({ secret: config.sessionSecret, repo: deps.repo, clock });
  const authenticator = deps.authenticator ?? auth;
  registerCallsignRoutes(app, {
    repo: deps.repo,
    auth,
    spawns: deps.spawns ?? listSpawnSystems(config.galaxySeed),
    clock,
  });
  registerSessionRoutes(app, { repo: deps.repo, authenticator });

  const sockets = attachWebSocket(app, {
    config,
    authenticator,
    directory: deps.directory,
    clock,
    timers: deps.timers ?? realTimers,
    log: app.log,
  });

  if (options.staticDir && existsSync(options.staticDir)) {
    void app.register(fastifyStatic, { root: options.staticDir });
  }

  return Object.assign(app, { sockets });
}
