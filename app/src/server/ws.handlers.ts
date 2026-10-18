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
import type {
  AuthResolver,
  JoinResolver,
  LogoutResolver,
  WarpResolver,
  WsHandleOptions,
} from "./ws.js";
import {
  chatValidationMessage,
  chatWindowMessage,
  sanitizeChatText,
  validateChatText,
} from "./chat.js";
import { broadcastChat, handleDisembark, pushPlayerInput } from "./shard/index.js";
import { sendError, sendFrame } from "./ws.dispatch.helpers.js";

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
    // TASK-12: set the connection's systemId BEFORE invoking the
    // resolver so the router's presence broadcaster (which runs
    // inside `joinSystem`) can see this connection in the registry.
    // On resolver failure we restore `null` below.
    conn.systemId = join.systemId;
    const result = await joinResolver(join.systemId, conn.callsign, conn.connId);
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
    // Restore systemId so the connection-close hook doesn't try to
    // leaveSystem a system we never actually joined.
    conn.systemId = null;
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
// onChat — TASK-16 system-wide chat
// ---------------------------------------------------------------------------

/**
 * Chat-specific handler (TASK-16). The general token bucket has
 * already accepted the frame by the time we get here; the chat
 * pipeline runs validation → sanitization → rate-limit →
 * broadcast (or `rate-limited` rejection).
 *
 * ## Pipeline
 *
 *   1. **Validate** (`validateChatText`) — the text must be a
 *      non-empty string whose trimmed length is ≤ 200 characters.
 *      Failures yield a structured `invalid-message` error frame;
 *      the spec wants this on a per-frame basis so the client can
 *      debug its own input.
 *   2. **Sanitize** (`sanitizeChatText`) — strip control bytes +
 *      zero-width / bidi marks, collapse whitespace. Applied BEFORE
 *      the rate-limit so a malicious client can't pollute the log
 *      with control bytes by typing just a few characters.
 *   3. **Rate limit** (`conn.chatWindowLimiter`) — the per-connection
 *      5 / 10 s sliding window. Rejections yield a `rate-limited`
 *      error frame.
 *   4. **Broadcast** (`broadcastChat`) — append to the shard log +
 *      send `{type: "chat", payload: ChatEntry}` to every
 *      connection in the shard (sender included).
 *
 * The pipeline is intentionally quiet on the failure paths: a
 * malformed chat message does NOT escalate to a flood close the way
 * a chat-limiter violation did in TASK-65's older code path. The
 * TASK-16 spec only asks for the structured error frame.
 *
 * The handler reads `conn.shard` via the WS-layer wiring
 * (`options.shardFor(conn)`). When the connection isn't in a
 * system, we drop silently — the dispatch guard in
 * `ws.dispatch.ts` already rejects `chat` frames from non-`joined`
 * connections, but the seam is here for the test harness.
 */
export function onChat(
  conn: Connection,
  _registry: ConnectionRegistry,
  options: WsHandleOptions,
  payload: unknown,
): void {
  // 1. Validate.
  const v = validateChatText((payload as { text: unknown } | undefined)?.text);
  if (!v.accepted) {
    sendError(conn, "invalid-message", chatValidationMessage(v.reason));
    return;
  }
  const now = (options.now ?? Date.now)();

  // 2. Sanitize. Always run even on accept so the wire text matches
  // what the rest of the shard sees (defensive: a "good" string is
  // usually a no-op but a stray tab shouldn't survive).
  const sanitized = sanitizeChatText(v.trimmed);

  // 3. Rate limit.
  const rl = conn.chatWindowLimiter.check(now);
  if (!rl.accepted) {
    sendError(conn, "rate-limited", chatWindowMessage());
    return;
  }

  // 4. Broadcast. The connection must be in a system for the
  // broadcast to have anywhere to send; without one the dispatch
  // guard already rejects. We use the `shardFor` seam so tests can
  // inject a stub.
  const shard = options.shardFor?.(conn);
  if (!shard) return;
  // The author is the connection's callsign; we fall back to a
  // sentinel so the test that bypasses the handshake still gets a
  // populated row.
  const author = conn.callsign ?? "UNKNOWN";
  broadcastChat(shard, { author, text: sanitized, ts: now });
  void _registry; // (silence unused-param; reserved for future hooks)
}

// ---------------------------------------------------------------------------
// onInput — TASK-17 player input → shard input slot
// ---------------------------------------------------------------------------

/**
 * TASK-17: route a validated `input` frame into the per-connection
 * input slot on the player's current shard. The dispatcher
 * pre-checks the state-machine (`conn.state === 'joined'` +
 * `conn.systemId !== null`) so by the time we reach here the
 * connection is in a system.
 *
 * The handler is intentionally silent on success — the client
 * already predicted locally (TASK-14) and the server only needs
 * to integrate the *latest* input on the next tick. The next
 * `entity_update` carries `lastAppliedSeq[playerId]` so the
 * client can drain its input queue on reconcile.
 *
 * ## Stale inputs (TASK-17 acceptance)
 *
 * If the lookup misses (the player has not joined a system yet,
 * or has just been dropped from the shard by a close/timeout),
 * `pushPlayerInput` returns `{ accepted: false, reason:
 * 'malformed' }` and the input is dropped. We emit a debug-level
 * `input-debug` event so an operator can confirm the slot is
 * healthy without spamming the log every frame.
 *
 * ## seq-protected slot
 *
 * The shard's input queue enforces a strict monotone `seq`:
 * first input must be `seq === 1` (cold-start guard), subsequent
 * inputs require `seq > lastSeq`. Stale frames increment
 * `staleDrops` on the connection for diagnostics.
 *
 * @see ../shard/input-queue.ts for the seq-protected slot.
 * @see ../shard/index.ts#pushPlayerInput for the wrapper.
 */
export function onInput(conn: Connection, options: WsHandleOptions, payload: unknown): void {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    // Defensive: the dispatcher should already reject inputs from
    // non-joined connections. If a malformed frame slips through
    // (e.g. an integration test wires only the chat path), silently
    // drop with a debug marker.
    options.debugLogger?.debug?.(`[drift-ws] input ignored: conn ${conn.connId} has no shard`);
    return;
  }
  const result = pushPlayerInput(shard, conn.connId, payload as never);
  if (!result.accepted) {
    // Stale-seq or malformed. The queue already incremented
    // `staleDrops`; surface the reason through the shard's event
    // bus so an operator can grep for it.
    shard.events.emit("input-debug", {
      connId: conn.connId,
      seq: (payload as { seq?: number }).seq,
      reason: result.reason,
    });
  }
}

// ---------------------------------------------------------------------------
// onWarp — TASK-8 inter-system travel
// ---------------------------------------------------------------------------

/**
 * Handle a `warp { targetSystemId }` frame from a `joined`-state
 * connection. The resolver does the actual work:
 *
 *   1. Validates the player + ship exist in the DB.
 *   2. Flushes the source shard so the ship state survives the warp.
 *   3. Computes the target's spawn gate (100 u along +X from the
 *      target star, facing the star).
 *   4. Updates the persisted ship row to the gate position.
 *   5. Drops the connection from the source shard.
 *   6. Spawns the target shard on demand and joins the connection.
 *   7. Returns the canonical target-system snapshot.
 *
 * On success: send a `warp_arrived` frame with the snapshot. The
 * connection's `systemId` is updated to the target so subsequent
 * frames route through the new shard (TASK-12 wired
 * `presenceBroadcaster` reads `conn.systemId` to decide who gets
 * the broadcast).
 *
 * On rejection (resolver throws a tagged error): send a structured
 * `error` frame with the resolver's code + message, restore the
 * connection's `systemId` so a stray close hook doesn't drop the
 * player twice, and stay connected so the player can pick a
 * different target.
 *
 * The handler is intentionally tolerant of any
 * `code: ...` string the resolver sets — a future TASK can
 * introduce new rejection codes (e.g. `warp-busy` if a second
 * warp races the first) without a dispatch table update.
 */
export async function onWarp(
  conn: Connection,
  warpResolver: WarpResolver,
  _options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  if (conn.callsign === null) {
    sendError(conn, "unauthenticated", "warp requires prior auth");
    return;
  }
  if (conn.systemId === null) {
    sendError(conn, "unauthenticated", "warp requires a joined system");
    return;
  }
  const warp = payload as { targetSystemId: string };
  const targetSystemId = warp.targetSystemId;
  const fromSystemId = conn.systemId;

  try {
    const result = await warpResolver(targetSystemId, conn.callsign, conn.connId, fromSystemId);
    conn.systemId = result.systemId;
    sendFrame(conn, "warp_arrived", {
      targetSystemId: result.targetSystemId,
      systemId: result.systemId,
      entities: result.entities,
      nodes: result.nodes,
      chat: result.chat,
      players: result.players,
      serverTickHz: result.serverTickHz,
      snapshotTick: result.snapshotTick,
    });
  } catch (err) {
    // Resolver throws tagged errors so we can pick the right code.
    // Default to `system-not-found` so an un-tagged throw doesn't
    // silently 200 — the client gets a structured error either way.
    const code = (err as { code?: string }).code ?? "system-not-found";
    // Leave `conn.systemId` as it was so any later `leaveSystem`
    // hook (TASK-12 connection-close) operates on the correct
    // shard. For same-system rejections we already left the
    // source; for un-found-system rejections we never moved; for
    // target-full rejections the resolver rolls back the
    // persisted row. Either way `fromSystemId` is the truth.
    conn.systemId = fromSystemId;
    sendError(conn, code, (err as Error).message ?? "warp failed");
  }
  void _options;
}

// ---------------------------------------------------------------------------
// onExitShip — TASK-31 player disembark
// ---------------------------------------------------------------------------

/**
 * Handle an `exit_ship` frame from a `joined`-state connection.
 *
 * The flow:
 *   1. Locate the shard for this connection (via `options.shardFor`).
 *   2. Delegate to `handleDisembark(shard, { connId })` which:
 *      - resolves the connection's bound ship entity,
 *      - enforces `onPad !== null` (the spec's "must be in a docked
 *        ship" precondition),
 *      - mints a character entity at `ship.pos + sideOffset`,
 *      - rebinds the connection's `entityId` to the character.
 *   3. On success: do nothing — `handleDisembark` already kicked
 *      a snapshot via `shard.broadcast(...)` so every client sees
 *      the character appear on the next wire frame. The owning
 *      client's `entity_update` will switch its controls + camera
 *      handoff (TASK-27) on receipt.
 *   4. On rejection: send a structured `error` frame with the
 *      resolver's code. `not-docked` and `no-ship` are the two
 *      expected codes; an unknown code falls back to
 *      `invalid-message` so the client gets a structured error
 *      either way.
 *
 * The handler is intentionally fire-and-forget on success — there
 * is no `exit_ship_ok` frame because the *snapshot* IS the
 * confirmation. The owning client sees its own character in the
 * next `entity_update` (≤ 100 ms later) and swaps the input
 * pipeline accordingly.
 */
export function onExitShip(conn: Connection, options: WsHandleOptions, _payload: unknown): void {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "exit_ship requires a joined system");
    return;
  }
  const result = handleDisembark(shard, { connId: conn.connId });
  if (!result.ok) {
    // Wire code map: `not-docked` -> `not-docked` (TASK-31
    // acceptance); `no-ship` / `unknown` -> `invalid-message`
    // (the spec's pre-existing code) so the client gets a
    // structured error either way.
    const code = result.code === "not-docked" ? "not-docked" : "invalid-message";
    sendError(conn, code, result.message);
    return;
  }
  // No outbound frame — the next broadcast carries the character.
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
