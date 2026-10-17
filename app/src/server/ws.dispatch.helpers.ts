/**
 * Server-only outbound helpers used by both `ws.dispatch.ts` and
 * `ws.handlers.ts`.
 *
 * Extracted from `ws.dispatch.ts` so the dispatch orchestrator stays
 * under the AGENTS.md line cap and so the per-state handlers can
 * import the same writer without duplicating the readyState guard.
 *
 *   - `sendFrame(conn, type, payload)` — encode + send a typed frame.
 *   - `sendError(conn, code, message)` — encode + send an error frame.
 *   - `closeFloodedConnection(conn, registry)` — close with code 4009
 *      and reason `flooded`, then remove from the registry. Used by
 *      both the general-bucket rate violation path (ws.dispatch.ts)
 *      and the chat-limiter rejection path (ws.handlers.ts).
 */
import { encodeEnvelope, type MessageType } from "@shared/protocol/index.js";

import type { Connection, ConnectionRegistry } from "./ws.connection.js";
import { FLOOD_CLOSE_CODE, FLOOD_CLOSE_REASON } from "./ratelimit.js";

/**
 * Encode + send a typed frame if the socket is still open. Used by the
 * dispatch pipeline (responses to `hello`, `auth_ok`, `enter_system`,
 * pong, etc.) and by the per-state handlers.
 */
export function sendFrame(conn: Connection, type: MessageType, payload: unknown): void {
  if (conn.ws.readyState !== conn.ws.OPEN) return;
  conn.ws.send(encodeEnvelope(type, payload));
}

/**
 * Encode + send an error frame. Centralised so we don't accidentally
 * ship different error envelope shapes per call site.
 */
export function sendError(conn: Connection, code: string, message: string): void {
  if (conn.ws.readyState !== conn.ws.OPEN) return;
  conn.ws.send(encodeEnvelope("error", { code, message }));
}

/**
 * Tear down a connection that has hit the flood-tracker threshold.
 * Sends `ws.close(4009, "flooded")`, transitions the connection state
 * to `closed`, and removes it from the registry so the keepalive
 * loop doesn't try to ping it.
 *
 * Errors from `ws.close()` (socket already torn down) are silenced —
 * the registry removal runs regardless.
 */
export function closeFloodedConnection(conn: Connection, registry: ConnectionRegistry): void {
  try {
    conn.ws.close(FLOOD_CLOSE_CODE, FLOOD_CLOSE_REASON);
  } catch {
    // socket already torn down; the close handler will clean up.
  }
  conn.state = "closed";
  registry.remove(conn.ws);
}
