/**
 * Per-connection bookkeeping for the Drift WebSocket server (TASK-9).
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
 * `ConnectionRegistry` is a thin `Map<WebSocket, Connection>` wrapper
 * because we want metadata alongside each socket — `ws.Server.clients`
 * doesn't carry our extensions.
 */
import type { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-connection handshake state machine. */
export type WsConnectionState = "hello" | "authed" | "joined" | "closed";

/**
 * A snapshot of a connection's mutable state, suitable for tests/diagnostics
 * and for the `onStateChange` lifecycle hook.
 */
export interface WsConnectionRecord {
  state: WsConnectionState;
  playerId: string | null;
  callsign: string | null;
  systemId: string | null;
  unknownTypeCount: number;
  lastSeenAt: number;
}

/** Internal: the live connection handle + metadata. */
export interface Connection {
  ws: WebSocket;
  state: WsConnectionState;
  playerId: string | null;
  callsign: string | null;
  systemId: string | null;
  unknownTypeCount: number;
  lastSeenAt: number;
  lastPingedAt: number;
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
  return {
    state: c.state,
    playerId: c.playerId,
    callsign: c.callsign,
    systemId: c.systemId,
    unknownTypeCount: c.unknownTypeCount,
    lastSeenAt: c.lastSeenAt,
  };
}
