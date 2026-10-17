/**
 * Per-state message handlers for the Drift WebSocket server (TASK-9 / 64 / 65).
 *
 * Split out of `ws.dispatch.ts` to keep AGENTS.md's 200-300 line cap on
 * the dispatcher. The handlers here are pure functions on
 * `(conn, registry, ...resolvers, options, payload)`; the dispatch
 * orchestrator in `ws.dispatch.ts` owns the call site + outbound
 * helpers + state-transition observer.
 *
 * The dispatch orchestrator imports these handlers and the outbound
 * helpers (`sendFrame`, `sendError`) from `./ws.dispatch.helpers.ts`.
 */
import { PROTOCOL_VERSION } from "@shared/protocol/index.js";

import type { Connection, ConnectionRegistry, WsConnectionState } from "./ws.connection.js";
import { snapshotConnection } from "./ws.connection.js";
import type { AuthResolver, JoinResolver, LogoutResolver, WsHandleOptions } from "./ws.js";
import { chatLimitMessage } from "./ratelimit.js";
import { closeFloodedConnection, sendError, sendFrame } from "./ws.dispatch.helpers.js";

// ---------------------------------------------------------------------------
// onHello
// ---------------------------------------------------------------------------

/**
 * Handle a validated `hello` frame from a `hello`-state connection.
 * The dispatcher pre-checks the version-mismatch case for the envelope,
 * but the per-type schema only enforces `version` is a non-negative
 * integer — anything else is rejected here.
 *
 * Acceptance flow:
 *   - server responds with `{ version, serverTickHz }` so the client
 *     learns both the protocol match and the authoritative server tick
 *     rate it should interpolate at.
 *   - the connection transitions to `authed`.
 *
 * Non-matching version → close 1002 (`version-mismatch`); same wire
 * code as the envelope-level version check.
 */
export async function onHello(
  conn: Connection,
  registry: ConnectionRegistry,
  options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  // Type already validated by parseMessage; payload is `Hello`.
  const hello = payload as { version: number; client?: string };
  if (hello.version !== PROTOCOL_VERSION) {
    sendError(
      conn,
      "version-mismatch",
      `Client sent version ${hello.version}; server is ${PROTOCOL_VERSION}`,
    );
    conn.ws.close(1002, "version-mismatch");
    conn.state = "closed";
    registry.remove(conn.ws);
    return;
  }
  sendFrame(conn, "hello", { version: PROTOCOL_VERSION, serverTickHz: 20 });
  transition(conn, options, "authed");
}

// ---------------------------------------------------------------------------
// onAuth
// ---------------------------------------------------------------------------

/**
 * Handle a validated `auth` frame from an `authed`-state connection.
 * Delegates to the resolver to derive `(playerId, callsign, expiry)`,
 * then transitions the connection to `joined`.
 *
 * On resolver rejection: send `unauthenticated` error + close 1008 so
 * the client knows the auth failed and stops retrying on the same
 * socket. The connection is removed from the registry so it doesn't
 * linger in diagnostics.
 */
export async function onAuth(
  conn: Connection,
  registry: ConnectionRegistry,
  authResolver: AuthResolver,
  options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  try {
    const result = await authResolver(payload);
    conn.playerId = result.playerId;
    conn.callsign = result.callsign;
    sendFrame(conn, "auth_ok", {
      playerId: result.playerId,
      callsign: result.callsign,
      tokenExpiresAt: result.tokenExpiresAt,
    });
    transition(conn, options, "joined");
  } catch (err) {
    sendError(conn, "unauthenticated", (err as Error).message ?? "auth failed");
    conn.ws.close(1008, "unauthenticated");
    conn.state = "closed";
    registry.remove(conn.ws);
  }
}

// ---------------------------------------------------------------------------
// onJoinSystem
// ---------------------------------------------------------------------------

/**
 * Handle a `join_system` frame from a `joined`-state connection. The
 * state-machine guard in `dispatch` already enforces `conn.callsign
 * !== null` (TASK-9 handshake), so the second check below is a
 * belt-and-braces guard for tests that bypass the handshake.
 *
 * On resolve: emit `enter_system` with the canonical snapshot.
 * On reject: emit a structured `error` frame and **leave the connection
 * alive** so the client can pick a different system.
 */
export async function onJoinSystem(
  conn: Connection,
  joinResolver: JoinResolver,
  options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  if (conn.callsign === null) {
    sendError(conn, "unauthenticated", "join_system requires prior auth");
    return;
  }
  const join = payload as { systemId: string };
  try {
    const result = await joinResolver(join.systemId, conn.callsign);
    conn.systemId = result.systemId;
    sendFrame(conn, "enter_system", {
      systemId: result.systemId,
      entities: result.entities,
      nodes: result.nodes,
      chat: result.chat,
      players: result.players,
      serverTickHz: result.serverTickHz,
      snapshotTick: result.snapshotTick,
    });
    void options; // state already 'joined' by the time we reach here
  } catch (err) {
    // Resolvers throw tagged errors so we can pick the right code.
    const code = (err as { code?: string }).code ?? "system-not-found";
    sendError(conn, code, (err as Error).message ?? "join failed");
    // Connection stays alive so the client can try a different system.
  }
}

// ---------------------------------------------------------------------------
// onLogout — TASK-66 client-initiated sign-out
// ---------------------------------------------------------------------------

/**
 * Handle a `logout` frame from a `joined`-state connection. Calls the
 * logout resolver to revoke *all* of this player's session rows (the
 * shared-account model: one logout = sign out everywhere), then closes
 * the WS connection with code 1000 (`normal-closure`).
 *
 * Success path:
 *   1. Server sends `{type:'logout_ok', payload:{callsign}}` so the
 *      client can show a personalised sign-out toast.
 *   2. Server closes with `1000 normal-closure`.
 *
 * Failure paths:
 *   - No `playerId` set (callset bypass) → `unauthenticated` error +
 *     stay connected. An unauthenticated client cannot meaningfully
 *     sign out.
 *   - Resolver rejects → `unauthenticated` error + close 1008. The
 *     client should not retry because the session state is broken.
 *
 * Concurrent connections holding the same token will lose access the
 * next time they hit any auth-gated route, but are NOT proactively
 * disconnected. A future task can wire a presence-broadcast push
 * (TASK-15) to actively close sibling sockets if desired; this
 * baseline satisfies the TASK-66 acceptance criterion (the WS that
 * sent the logout is closed with 1000).
 */
export async function onLogout(
  conn: Connection,
  registry: ConnectionRegistry,
  logoutResolver: LogoutResolver,
  options: WsHandleOptions,
  _payload: unknown,
): Promise<void> {
  if (conn.playerId === null) {
    sendError(conn, "unauthenticated", "logout requires prior auth");
    return;
  }
  try {
    const result = await logoutResolver(conn.playerId);
    sendFrame(conn, "logout_ok", { callsign: result.callsign ?? conn.callsign ?? "" });
    try {
      conn.ws.close(1000, "logged-out");
    } catch {
      // socket already torn down; the close handler cleans up.
    }
    conn.state = "closed";
    registry.remove(conn.ws);
  } catch (err) {
    sendError(conn, "unauthenticated", (err as Error).message ?? "logout failed");
    try {
      conn.ws.close(1008, "logout-failed");
    } catch {
      // ignore
    }
    conn.state = "closed";
    registry.remove(conn.ws);
  }
  void options; // (silence unused-param; options reserved for future hooks)
}

// ---------------------------------------------------------------------------
// onChat — TASK-65 chat limiter
// ---------------------------------------------------------------------------

/**
 * Chat-specific handler (TASK-65). The chat limiter is consulted AFTER
 * the general token bucket has already accepted this frame, so by the
 * time we get here the connection is permitted to spend *one* of its
 * budget on a chat message. The chat limiter makes a finer-grained
 * decision about whether this particular message fits the chat policy.
 *
 * On accept: message is silently consumed; TASK-16 broadcasts it.
 * On reject: a structured `rate-limited` error is sent, the violation
 * is recorded against `FloodTracker`, and — if escalation fires — the
 * connection is closed with code 4009 via `closeFloodedConnection`.
 */
export function onChat(
  conn: Connection,
  registry: ConnectionRegistry,
  options: WsHandleOptions,
  payload: unknown,
): void {
  // Type-validated by parseMessage; payload is `{ text: string }`.
  const p = payload as { text: string };
  const now = (options.now ?? Date.now)();
  const result = conn.chatLimiter.check(p.text.length, now);
  if (!result.accepted) {
    sendError(conn, "rate-limited", chatLimitMessage(result.reason));
    if (conn.floodTracker.noteViolation(now)) {
      closeFloodedConnection(conn, registry);
    }
  }
  // Accepted: TASK-16 owns the broadcast hook. No acknowledgement is
  // sent — the server doesn't echo chat back to its author.
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Apply a state transition and notify any registered observer. Centralised
 * so tests can hook the lifecycle in a single place.
 */
function transition(conn: Connection, options: WsHandleOptions, next: WsConnectionState): void {
  const previous = conn.state;
  if (previous === next) return;
  conn.state = next;
  options.onStateChange?.(snapshotConnection(conn), previous);
}
