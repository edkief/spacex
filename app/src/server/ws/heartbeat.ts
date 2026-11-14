import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import type { Connection } from './connection.ts';
import type { WsDeps } from './context.ts';
import type { Hub } from './hub.ts';

export const PING_INTERVAL_MS = 15_000;
export const SILENCE_LIMIT_MS = 45_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Pings every connection each 15 s and drops those silent for more than 45 s. Any inbound frame
 * counts as activity. Returns a function that stops the heartbeat.
 */
export function startHeartbeat(deps: WsDeps, hub: Hub): () => void {
  const handle = deps.timers.setInterval(() => {
    const now = deps.clock();
    for (const conn of [...hub.connections()]) {
      if (now - conn.lastSeenAt > SILENCE_LIMIT_MS) {
        conn.close(CLOSE_CODES.heartbeatTimeout, 'heartbeat-timeout');
        conn.terminate();
      } else {
        conn.send('ping', { t: now });
      }
    }
  }, PING_INTERVAL_MS);
  return () => deps.timers.clearInterval(handle);
}

/** Closes a connection that has not authenticated within 10 s of connecting. */
export function armHandshakeTimeout(conn: Connection, deps: WsDeps): void {
  const handle = deps.timers.setTimeout(() => {
    if (conn.state === 'connected' || conn.state === 'hello-ok') {
      conn.close(CLOSE_CODES.handshakeTimeout, 'handshake-timeout');
    }
  }, HANDSHAKE_TIMEOUT_MS);
  conn.onClose(() => deps.timers.clearTimeout(handle));
}
