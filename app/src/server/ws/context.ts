import type { FastifyBaseLogger } from 'fastify';
import type { ServerConfig } from '../config.ts';
import type { Authenticator } from '../auth/types.ts';
import type { SystemDirectory } from '../directory.ts';
import type { Timers } from '../timers.ts';
import type { Connection } from './connection.ts';
import type { Hub } from './hub.ts';

/** Everything the WebSocket layer depends on, injected so tests can substitute any of it. */
export interface WsDeps {
  config: ServerConfig;
  authenticator: Authenticator;
  directory: SystemDirectory;
  /** Epoch milliseconds. */
  clock: () => number;
  timers: Timers;
  log: FastifyBaseLogger;
}

/** What a handler is given alongside its already-validated payload. */
export interface HandlerContext {
  conn: Connection;
  deps: WsDeps;
  hub: Hub;
}
