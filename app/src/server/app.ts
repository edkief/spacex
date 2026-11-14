import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { buildHealth } from '@shared/health';
import { listSpawnSystems, type SpawnSystem } from '@shared/galaxy/spawn.ts';
import { createAuthService } from './auth/service.ts';
import { PROTOCOL_VERSION } from '@shared/protocol/envelope.ts';
import { CLOSE_CODES } from '@shared/protocol/errors.ts';
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
  /** Captures log output (the log-leak regression test reads it). Default: stdout. */
  logStream?: NodeJS.WritableStream;
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
    logger: {
      level: options.logLevel ?? (config.nodeEnv === 'test' ? 'silent' : 'info'),
      // Defence in depth: credentials never reach logs, and request URLs are logged without
      // their query string (tokens are not accepted there, but a client might send one).
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization'],
        censor: '[redacted]',
      },
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: request.url.split('?', 1)[0] ?? '',
          host: request.headers.host ?? '',
          remoteAddress: request.ip,
        }),
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
  });

  installErrorHandlers(app);

  app.get('/api/health', () => buildHealth(config.galaxySeed));
  // What a client needs before it can connect: the seed to generate from and where the socket is.
  app.get('/api/config', () => ({
    galaxySeed: config.galaxySeed,
    wsPath: config.wsPath,
    protocolVersion: PROTOCOL_VERSION,
  }));

  const clock = deps.clock ?? ((): number => Date.now());
  const auth = createAuthService({ secret: config.sessionSecret, repo: deps.repo, clock });
  const authenticator = deps.authenticator ?? auth;
  registerCallsignRoutes(app, {
    repo: deps.repo,
    auth,
    spawns: deps.spawns ?? listSpawnSystems(config.galaxySeed),
    clock,
  });

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

  registerSessionRoutes(app, {
    repo: deps.repo,
    authenticator,
    onRevoked: (tokenHash) => {
      sockets.hub.closeToken(tokenHash, CLOSE_CODES.loggedOut, 'logged-out');
    },
  });

  return Object.assign(app, { sockets });
}
