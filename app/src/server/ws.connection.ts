/**
 * Per-connection bookkeeping for the Drift WebSocket server (TASK-9 + TASK-64).
 *
 * Kept in its own module so `ws.ts` (the public API) stays focused on
 * lifecycle, and `ws.dispatch.ts` (the message router) can stay focused
 * on per-frame logic. Splitting the file keeps each module under the
 * 200-300 line ceiling enforced by `AGENTS.md`.
 *
 * The `Connection` struct carries everything we need to decide whether
 * to accept a frame: the per-connection state machine position, identity
 * fields populated by the handshake resolvers, and the timestamp needed
 * for the keepalive timeout.
 *
 * `invalidCount` is the per-connection strike counter (TASK-64): every
 * inbound frame that fails envelope/parse/validation increments it, and
 * the connection is dropped when it reaches `INVALID_DROP_THRESHOLD`
 * (see `./ws.dispatch.ts`). Renamed from the TASK-9 `unknownTypeCount`
 * because the counter now tracks *all* malformed inputs, not only
 * unknown message types.
 *
 * `ConnectionRegistry` is a thin `Map<WebSocket, Connection>` wrapper
 * because we want metadata alongside each socket — `ws.Server.clients`
 * doesn't carry our extensions.
 */
import type { WebSocket } from "ws";

import type { ChatLimiter, FloodTracker, TokenBucket } from "./ratelimit.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-connection handshake state machine. */
export type WsConnectionState = "hello" | "authed" | "joined" | "closed";

/**
 * A snapshot of a connection's mutable state, suitable for tests/diagnostics
 * and for the `onStateChange` lifecycle hook. Rate-limit state is
 * reported via counts (not the full classes) so the snapshot stays
 * JSON-serialisable and the test surface doesn't expose internal
 * references.
 */
export interface WsConnectionRecord {
  state: WsConnectionState;
  playerId: string | null;
  callsign: string | null;
  systemId: string | null;
  invalidCount: number;
  lastSeenAt: number;
  /** TASK-65: current token count in the general message bucket. */
  bucketTokens: number;
  /** TASK-65: count of rate-limit violations in the last 10 s. */
  floodViolations: number;
}

/** Internal: the live connection handle + metadata. */
export interface Connection {
  ws: WebSocket;
  state: WsConnectionState;
  playerId: string | null;
  callsign: string | null;
  systemId: string | null;
  invalidCount: number;
  lastSeenAt: number;
  lastPingedAt: number;
  /** TASK-65: per-connection general message token bucket (20/s, burst 40). */
  bucket: TokenBucket;
  /** TASK-65: sliding-window violation counter (3 in 10 s → drop). */
  floodTracker: FloodTracker;
  /** TASK-65: chat-specific gate (2 s gap / 280 chars / 10 per 30 s). */
  chatLimiter: ChatLimiter;
}

/**
 * Hand-rolled set of connections; `ws.Server.clients` is enough but we
 * want to attach our own metadata alongside each socket.
 */
export class ConnectionRegistry {
  private readonly map = new Map<WebSocket, Connection>();

  add(ws: WebSocket, conn: Connection): void {
    this.map.set(ws, conn);
  }

  remove(ws: WebSocket): void {
    this.map.delete(ws);
  }

  get(ws: WebSocket): Connection | undefined {
    return this.map.get(ws);
  }

  values(): IterableIterator<Connection> {
    return this.map.values();
  }
}

/** Convert a live `Connection` into the diagnostic record snapshot. */
export function snapshotConnection(c: Connection): WsConnectionRecord {
  const now = Date.now();
  return {
    state: c.state,
    playerId: c.playerId,
    callsign: c.callsign,
    systemId: c.systemId,
    invalidCount: c.invalidCount,
    lastSeenAt: c.lastSeenAt,
    bucketTokens: c.bucket.tokensForTesting,
    floodViolations: c.floodTracker.sizeForTesting(now),
  };
}
