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
import {
  broadcastChat,
  handleDisembark,
  handleEnterShip,
  handleFire,
  handleSelectWeapon,
  pushPlayerInput,
} from "./shard/index.js";
import { handleInteract } from "./shard/interact.js";
import type { InteractAction } from "@client/input/interaction.js";
import { handlePickup, handleDrop } from "./shard/inventory.js";
import { handleMineStart, handleMineStop, pushMiningUpdate } from "./shard/mining.js";
import { handleCargoTransfer, pushCargoUpdate } from "./shard/cargo.js";
import { handleSell } from "./shard/sell.js";
import { sendError, sendFrame } from "./ws.dispatch.helpers.js";
import { INVENTORY_WEIGHT_CAP, type Inventory } from "@shared/world/inventory.js";
import type { ProtocolInventoryUpdate } from "@shared/protocol/index.js";

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
  if (result.ok) {
    // TASK-36: rebroadcast presence so every client in the system
    // sees the player's state flip from `flying`/`docked` to
    // `onfoot` (and the icon swap in PlayerList fires on the
    // same frame the entity appears).
    options.presenceRebroadcaster?.(conn.systemId ?? shard.systemId);
  }
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
// onEnterShip — TASK-35 player re-entry from character to ship
// ---------------------------------------------------------------------------

/**
 * Handle a validated `enter_ship` frame from a `joined`-state
 * connection. The reverse of `onExitShip`: the player has walked
 * up to their own (docked or idle) ship and wants to board.
 *
 * The flow:
 *   1. Locate the shard for this connection (via `options.shardFor`).
 *   2. Delegate to `handleEnterShip(shard, { connId })` which:
 *      - confirms the connection is bound to a character,
 *      - reads `onShipId` to find the docked ship the player owns,
 *      - enforces ownership (`ship.playerId === conn.playerId`),
 *      - enforces the 5 m proximity radius (server-authoritative),
 *      - enforces the 1 u/s velocity cap (drifting allowed,
 *        moving rejected),
 *      - removes the character entity,
 *      - rebinds the connection's `entityId` to the ship,
 *      - forces a snapshot so every client sees the entity switch,
 *      - sends an `enter_ship_ok { shipId }` ack to the owning
 *        client (so the controls swap back to the flight scheme
 *        synchronously).
 *   3. On rejection: send a structured `error` frame carrying the
 *      resolver's code. Codes map directly to wire error codes:
 *        - `already-in-ship` -> `already-in-ship`
 *        - `not-owner`        -> `not-owner`
 *        - `ship-moving`      -> `ship-moving`
 *        - `out-of-range`     -> `out-of-range`
 *        - `not-on-foot`      -> `wrong-regime`
 *        - `no-entity` / `no-ship` / `unknown`
 *                            -> `invalid-message`
 *
 * Note: the success path is NOT a broadcast-only confirmation
 * like `exit_ship` is — we send an explicit `enter_ship_ok` ack
 * because the owning client wants to swap the camera + control
 * scheme the moment the server commits the rebind (the broadcast
 * may be a tick late in v1's 10 Hz cadence).
 */
export function onEnterShip(conn: Connection, options: WsHandleOptions, _payload: unknown): void {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "enter_ship requires a joined system");
    return;
  }
  const result = handleEnterShip(shard, { connId: conn.connId });
  if (result.ok) {
    // TASK-36: rebroadcast presence so every client in the system
    // sees the player's state flip from `onfoot` back to `flying`/
    // `docked` (and the icon swap in PlayerList fires on the same
    // frame the character entity is removed).
    options.presenceRebroadcaster?.(conn.systemId ?? shard.systemId);
    // The success ack was already pushed by `handleEnterShip`
    // (it owns the `shard.send(...)` so the entity switch and the
    // ack are guaranteed to land in the same frame).
    return;
  }
  const code = result.code;
  let wireCode:
    | "already-in-ship"
    | "not-owner"
    | "ship-moving"
    | "out-of-range"
    | "wrong-regime"
    | "invalid-message";
  switch (code) {
    case "already-in-ship":
    case "not-owner":
    case "ship-moving":
    case "out-of-range":
    case "not-on-foot":
      wireCode = code === "not-on-foot" ? "wrong-regime" : code;
      break;
    case "no-entity":
    case "no-ship":
    case "unknown":
      wireCode = "invalid-message";
      break;
  }
  sendError(conn, wireCode, result.message);
}

// ---------------------------------------------------------------------------
// onInteract — TASK-33 proximity interaction
// ---------------------------------------------------------------------------

/**
 * Handle a validated `interact` frame from a `joined`-state
 * connection.
 *
 * The flow:
 *   1. Locate the shard for this connection (via `options.shardFor`).
 *   2. Delegate to `handleInteract(shard, { connId, targetId, action })`
 *      which:
 *        - enforces `conn.entityId` is a character (else `wrong-regime`),
 *        - resolves the target entity in the shard registry (else `not-found`),
 *        - validates 3 m range server-side (else `out-of-range`),
 *        - dispatches via the `InteractableRegistry`.
 *   3. On success: emit `interact_ok` to the requesting connection so
 *      it can update its local prediction without waiting for the
 *      next snapshot. The dispatch itself may also have produced a
 *      `ui_open` frame (e.g. dock terminals) which the handler
 *      piggybacked onto `shard.send` — that frame streams out as
 *      part of the same loop. The next broadcast carries the
 *      result to every connection (e.g. a deposit removal).
 *   4. On rejection: emit a structured `error` frame with the
 *      resolver's code (`out-of-range` / `wrong-regime` / `not-found`).
 *
 * Validation order (regime → existence → range) matches the spec:
 * the prompt UI only ever shows valid targets, so the existence +
 * range checks are belt-and-braces against a frame that races the
 * prompt update.
 */
export async function onInteract(
  conn: Connection,
  options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "interact requires a joined system");
    return;
  }
  const p = payload as { targetId: string; action: string };
  const result = await handleInteract(shard, {
    connId: conn.connId,
    targetId: p.targetId,
    action: p.action as InteractAction,
    repo: options.repo ?? null,
  });
  if (!result.ok) {
    sendError(conn, result.code, result.message);
    return;
  }
  sendFrame(conn, "interact_ok", {
    targetId: result.targetId,
    action: result.action,
  });
}

// ---------------------------------------------------------------------------
// onPickup / onDrop — TASK-34 inventory
// ---------------------------------------------------------------------------

/**
 * Handle a `pickup` frame — TASK-34. Direct pickup path
 * (alternative to `interact { action: 'use' }` against a deposit
 * / ground item target).
 *
 * The handler routes through `handlePickup` so the validation +
 * weight-cap math share the same code path as the interact
 * registry. On success it pushes an `inventory_update` frame so the
 * client's HUD reflects the new shape without waiting for the next
 * entity_update.
 */
export async function onPickup(
  conn: Connection,
  options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "pickup requires a joined system");
    return;
  }
  if (!options.repo) {
    sendError(conn, "not-found", "Inventory backend unavailable");
    return;
  }
  const p = payload as { targetId: string };
  const result = await handlePickup(shard, options.repo, {
    connId: conn.connId,
    targetId: p.targetId,
  });
  if (!result.ok) {
    sendError(conn, result.code, result.message);
    return;
  }
  sendInventoryUpdate(conn, result.inventory, {
    action: result.remaining > 0 ? "pickup-partial" : "pickup-full",
    taken: result.taken,
    remaining: result.remaining,
  });
}

/**
 * Handle a `drop` frame — TASK-34. Spawns a ground-item entity at
 * the caller's position and removes the resource from the
 * inventory. On success it pushes an `inventory_update` so the
 * client HUD reflects the new shape.
 */
export async function onDrop(
  conn: Connection,
  options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "drop requires a joined system");
    return;
  }
  if (!options.repo) {
    sendError(conn, "not-found", "Inventory backend unavailable");
    return;
  }
  const p = payload as { resourceType: string; amount: number };
  const result = await handleDrop(shard, options.repo, {
    connId: conn.connId,
    resourceType: p.resourceType,
    amount: p.amount,
  });
  if (!result.ok) {
    sendError(conn, result.code, result.message);
    return;
  }
  sendInventoryUpdate(conn, result.inventory, {
    action: "drop",
    taken: result.dropped,
    remaining: 0,
  });
}

/**
 * Push an `inventory_update` frame to the requesting connection.
 * The wire shape is the canonical inventory plus a telemetry
 * triple so the client can render transient toast feedback without
 * a second API call.
 */
function sendInventoryUpdate(
  conn: Connection,
  inventory: Inventory,
  meta: { action: ProtocolInventoryUpdate["action"]; taken: number; remaining: number },
): void {
  sendFrame(conn, "inventory_update", {
    stacks: { ...inventory.stacks },
    weightUsed: inventory.weightUsed,
    capacity: INVENTORY_WEIGHT_CAP,
    action: meta.action,
    taken: meta.taken,
    remaining: meta.remaining,
  });
}

// ---------------------------------------------------------------------------
// onCargoTransfer — TASK-39 inventory ↔ hold transfer
// ---------------------------------------------------------------------------

/**
 * Handle a `cargo_transfer { resourceId, amount, from }` frame from
 * a `joined`-state connection.
 *
 * The flow:
 *   1. Locate the shard (via `options.shardFor`).
 *   2. Delegate to `handleCargoTransfer(shard, repo, args)` which:
 *      - enforces `conn.entityId` is a character (else `wrong-regime`),
 *      - resolves the ship's id via the character's `onShipId`
 *        (else `not-found`),
 *      - validates ownership (`ship.playerId === conn.playerId`),
 *      - validates the 5 m proximity bound (server-authoritative),
 *      - validates the resource id + amount,
 *      - applies the cap-bound math (`take what fits`),
 *      - persists inventory + cargo,
 *      - mirrors the new hold into the in-memory entity.
 *   3. On success: emit `cargo_update` carrying the new hold +
 *      inventory so the client HUD reflects the change on the same
 *      frame the server committed.
 *   4. On rejection: emit a structured `error` frame. Codes map to
 *      wire error codes as follows:
 *        - `wrong-regime`        → `wrong-regime`
 *        - `not-found`           → `not-found`
 *        - `unknown-resource`    → `invalid-message`
 *        - `not-owner`           → `not-owner`
 *        - `out-of-range`        → `out-of-range`
 *        - `insufficient-amount` → `invalid-message`
 *        - `inventory-full`      → `invalid-message`
 *        - `cargo-full`          → `invalid-message`
 *        - `invalid-amount`      → `invalid-message`
 *        - `ship-not-docked`     → `not-found`
 */
export async function onCargoTransfer(
  conn: Connection,
  options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "cargo_transfer requires a joined system");
    return;
  }
  if (!options.repo) {
    sendError(conn, "not-found", "Cargo backend unavailable");
    return;
  }
  const p = payload as {
    resourceId: string;
    amount: number;
    from: "inv" | "hold";
  };
  const result = await handleCargoTransfer(shard, options.repo, {
    connId: conn.connId,
    resourceId: p.resourceId,
    amount: p.amount,
    from: p.from,
  });
  if (!result.ok) {
    let wireCode: "invalid-message" | "wrong-regime" | "not-found" | "not-owner" | "out-of-range";
    switch (result.code) {
      case "wrong-regime":
        wireCode = "wrong-regime";
        break;
      case "not-owner":
        wireCode = "not-owner";
        break;
      case "out-of-range":
        wireCode = "out-of-range";
        break;
      case "not-found":
      case "ship-not-docked":
        wireCode = "not-found";
        break;
      default:
        wireCode = "invalid-message";
        break;
    }
    sendError(conn, wireCode, result.message);
    return;
  }
  pushCargoUpdate(shard, conn.connId, {
    cargo: result.cargo,
    inventory: result.inventory,
    direction: result.direction,
    resourceId: result.resourceId,
    transferred: result.transferred,
    remaining: result.remaining,
    action: result.direction === "inv" ? "move-to-hold" : "move-to-inventory",
  });
}

// ---------------------------------------------------------------------------
// onSell — TASK-40 dock sell action
// ---------------------------------------------------------------------------

/**
 * Handle a `sell { resourceType, quantity, source? }` frame from a
 * `joined`-state connection.
 *
 * The flow:
 *   1. Locate the shard (via `options.shardFor`).
 *   2. Delegate to `handleSell(shard, repo, args)` which:
 *      - resolves the bound entity (ship or character),
 *      - validates "at a station":
 *          * ship → must be docked (`onPad !== null`),
 *          * character → must be within 10 m of a docked ship's
 *            terminal position,
 *      - reads the inventory + cargo from the DB,
 *      - computes the new stacks via the pure `sellStack(...)`,
 *      - adds credits via the atomic `repo.addCredits(...)` (TASK-41
 *        compare-and-swap guard),
 *      - persists the new shape (inventory or cargo).
 *   3. On success: emit `sell_ok` carrying the sold + earned +
 *      newBalance + source so the client HUD can render the
 *      "+240 cr" floating text on the same frame.
 *   4. On rejection: emit a structured `error` frame. Codes map to
 *      wire error codes as follows:
 *        - `not-at-station`  → `not-at-station`
 *        - `not-docked`      → `not-docked`
 *        - `unknown-resource` → `invalid-message`
 *        - `insufficient`    → `insufficient`
 *        - `invalid-amount`  → `invalid-message`
 *        - `not-found`       → `not-found`
 */
export async function onSell(
  conn: Connection,
  options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "sell requires a joined system");
    return;
  }
  if (!options.repo) {
    sendError(conn, "not-found", "Sell backend unavailable");
    return;
  }
  const p = payload as {
    resourceType: string;
    quantity: number;
    source?: "inv" | "hold";
  };
  const result = await handleSell(shard, options.repo, {
    connId: conn.connId,
    resourceType: p.resourceType,
    amount: p.quantity,
    source: p.source,
  });
  if (!result.ok) {
    let wireCode:
      "not-at-station" | "not-docked" | "insufficient" | "invalid-message" | "not-found";
    switch (result.code) {
      case "not-at-station":
        wireCode = "not-at-station";
        break;
      case "not-docked":
        wireCode = "not-docked";
        break;
      case "insufficient":
        wireCode = "insufficient";
        break;
      case "not-found":
        wireCode = "not-found";
        break;
      default:
        wireCode = "invalid-message";
        break;
    }
    sendError(conn, wireCode, result.message);
    return;
  }
  sendFrame(conn, "sell_ok", {
    resourceType: result.resourceType,
    quantity: result.requested,
    sold: result.sold,
    earned: result.earned,
    newBalance: result.newBalance,
    source: result.source,
  });
}

// ---------------------------------------------------------------------------
// onFire / onSelectWeapon — TASK-43 weapon fire intent
// ---------------------------------------------------------------------------

/**
 * Handle a `fire { weapon, targetId? }` frame from a `joined`-
 * state connection.
 *
 * The flow:
 *   1. Locate the shard.
 *   2. Delegate to `handleFire(shard, { connId, weapon, targetId?, nowMs })`.
 *   3. On accept: `handleFire` emits the `fire_ok` and
 *      `weapon_state` frames itself (and the resolver emits
 *      `combat_event` for laser hits).
 *   4. On deny: emit a structured `error` frame with the
 *      `FireResult.code`. The client HUD reads the code to
 *      render the appropriate toast ("LOW ENERGY", "weapon
 *      locked", etc.). The spec is explicit: a denied fire
 *      shows NO FX.
 */
export function onFire(conn: Connection, options: WsHandleOptions, payload: unknown): void {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "fire requires a joined system");
    return;
  }
  const p = payload as { weapon: "laser" | "missile"; targetId?: string | null };
  const result = handleFire({
    shard,
    connId: conn.connId,
    weapon: p.weapon,
    targetId: p.targetId ?? null,
    nowMs: (options.now ?? Date.now)(),
  });
  if (result.ok === "denied") {
    let wireCode:
      | "rate-limited"
      | "low-energy"
      | "weapon-locked"
      | "weapon-not-equipped"
      | "out-of-range"
      | "not-attackable"
      | "self-target"
      | "no-target"
      | "unknown";
    switch (result.code) {
      case "rate-limited":
        wireCode = "rate-limited";
        break;
      case "low-energy":
        wireCode = "low-energy";
        break;
      case "weapon-locked":
        wireCode = "weapon-locked";
        break;
      case "weapon-not-equipped":
        wireCode = "weapon-not-equipped";
        break;
      case "out-of-range":
        wireCode = "out-of-range";
        break;
      case "not-attackable":
        wireCode = "not-attackable";
        break;
      case "self-target":
        wireCode = "self-target";
        break;
      case "no-target":
        wireCode = "no-target";
        break;
      default:
        wireCode = "unknown";
        break;
    }
    sendError(conn, wireCode, `Fire denied: ${result.code}`);
    return;
  }
  // Accepted: `handleFire` already pushed `fire_ok` + `weapon_state`
  // (and `resolveHit` pushed the `combat_event` for laser hits).
  // The handler is silent on accept.
  void result;
}

/**
 * Handle a `select_weapon { weapon }` frame from a `joined`-
 * state connection. The server records the new active weapon
 * and pushes a `weapon_state` so the HUD selector flips
 * synchronously.
 *
 * A scout requesting `missile` is silently accepted (the
 * server doesn't reject un-equipped switches — the player can
 * still try to fire and the resulting `weapon-not-equipped`
 * surfaces the "you don't have that weapon" feedback on the
 * same frame they press the trigger).
 */
export function onSelectWeapon(conn: Connection, options: WsHandleOptions, payload: unknown): void {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "select_weapon requires a joined system");
    return;
  }
  const p = payload as { weapon: "laser" | "missile" };
  handleSelectWeapon({
    shard,
    connId: conn.connId,
    weapon: p.weapon,
    nowMs: (options.now ?? Date.now)(),
  });
}

// ---------------------------------------------------------------------------
// onMine / onMineStop — TASK-38 long-running extraction
// ---------------------------------------------------------------------------

/**
 * Handle a `mine` frame from a `joined`-state connection.
 *
 * The flow:
 *   1. Locate the shard (via `options.shardFor`).
 *   2. Delegate to `handleMineStart(shard, { connId, depositId, nowMs })`
 *      which:
 *        - enforces `conn.entityId` is a character (else `wrong-regime`),
 *        - resolves the target deposit in the shard registry (else `not-found`),
 *        - validates 3 m range server-side (else `out-of-range`),
 *        - rejects `depleted` if the deposit has no units left,
 *        - rejects `already-mining` if a different deposit is being mined.
 *   3. On success: emit `mining_update { state: 'mining', progressMs: 0 }`
 *      so the client UI's "started just now" state is server-timed. The
 *      actual cadence is driven by `advanceMining` on every sim tick;
 *      this initial frame is the only echo the WS handler pushes.
 *   4. On rejection: emit a structured `error` frame with the
 *      resolver's code. The handler is intentionally tolerant of
 *      any extra code we add in the future — `wrong-regime`,
 *      `not-found`, `out-of-range`, `depleted`, `already-mining`.
 */
export async function onMine(
  conn: Connection,
  options: WsHandleOptions,
  payload: unknown,
): Promise<void> {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "mine requires a joined system");
    return;
  }
  const p = payload as { nodeId: string };
  const result = handleMineStart(shard, {
    connId: conn.connId,
    depositId: p.nodeId,
    nowMs: (options.now ?? Date.now)(),
  });
  if (!result.ok) {
    const wireCode =
      result.code === "depleted" || result.code === "already-mining"
        ? "invalid-message"
        : result.code === "wrong-regime"
          ? "wrong-regime"
          : result.code === "not-found"
            ? "not-found"
            : "out-of-range";
    sendError(conn, wireCode, result.message);
    return;
  }
  // Push an initial `mining_update` so the client UI knows the
  // channel opened. The shard's sim loop drives subsequent
  // updates at the 1.5 s cadence.
  pushMiningUpdate(shard, conn.connId, {
    depositId: result.depositId,
    resourceId: result.resourceId,
    progressMs: 0,
    unitsSoFar: 0,
    amount: result.amount,
    state: "mining",
  });
}

/**
 * Handle a `mine_stop` frame from a `joined`-state connection.
 *
 * Idempotent: a stop without an active mining row returns
 * `not-mining`, which surfaces as a structured `invalid-message`
 * error so the client can distinguish a clean release from a
 * server bug. The success path emits a final `mining_update`
 * carrying `state: 'cancelled'` and the current `unitsSoFar`
 * so the client can show "+2 iron" feedback while the prompt
 * hides.
 */
export function onMineStop(conn: Connection, options: WsHandleOptions, _payload: unknown): void {
  const shard = options.shardFor?.(conn);
  if (!shard) {
    sendError(conn, "unauthenticated", "mine_stop requires a joined system");
    return;
  }
  const result = handleMineStop(shard, { connId: conn.connId });
  if (!result.ok) {
    sendError(conn, "invalid-message", result.message);
    return;
  }
  // Final echo so the client can hide the radial + show the
  // earned-amount toast. The deposit id is unknown here because
  // the row was already cleared, but the client can derive it
  // from the last `mining_update` it received.
  pushMiningUpdate(shard, conn.connId, {
    depositId: "",
    resourceId: "",
    progressMs: 0,
    unitsSoFar: result.unitsAwarded,
    amount: 0,
    state: "cancelled",
  });
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
