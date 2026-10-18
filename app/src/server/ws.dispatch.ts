/**
 * Per-frame message routing for the Drift WebSocket server (TASK-9 + 64 + 65).
 *
 * Extracted from `ws.ts` so the state machine + per-handler logic can
 * be exercised by tests with a stubbed `Connection`. The `ws.ts` module
 * owns the WebSocket lifecycle; this module owns what happens once a
 * frame has been read off the wire.
 *
 * The per-state handlers (`onHello`, `onAuth`, `onJoinSystem`,
 * `onChat`) live in `./ws.handlers.ts` and the outbound helpers
 * (`sendFrame`, `sendError`, `closeFloodedConnection`) in
 * `./ws.dispatch.helpers.ts`. This file is the orchestrator: pipeline +
 * state-machine dispatch + the two centralised strike helpers.
 *
 * Public API (kept stable so tests can drive it directly):
 *   - `processRawFrame(conn, registry, authResolver, joinResolver, options, raw)`
 *   - `noteInvalidInput(conn, registry, code, message)` — centralised
 *     handler for any malformed frame (TASK-64).
 *   - `noteRateViolation(conn, registry, options, now, code, message)` —
 *     centralised handler for any rate-limit violation (TASK-65).
 *   - `INVALID_DROP_THRESHOLD`, `MAX_MESSAGE_BYTES`, `PROTOCOL_VERSION`
 *
 * State machine:
 *   hello  ──hello──▶  authed  ──auth──▶  joined
 *                                           │
 *                                      ──join_system──▶  joined (with systemId)
 *
 * Validation policy (TASK-64 + TASK-65):
 *   0. Rate-limit gate (TASK-65): bucket exhaustion → `rate-limited`.
 *   1. Envelope decode (`decodeEnvelope`) uses `z.safeParse` and returns
 *      a `ProtocolError("invalid-envelope")` on shape mismatch / non-JSON.
 *      We forward these as `invalid-message` (per the spec: clients only
 *      see one invalid-input code) and bump the validation-strike counter.
 *   2. `parseMessage` validates the per-type payload with `z.safeParse`
 *      and throws `ProtocolError` on failure. Unknown types throw
 *      `ProtocolError("unknown-type")`, schema mismatches throw
 *      `ProtocolError("invalid-message")`. Both routes increment the
 *      strike counter and drop the connection at `INVALID_DROP_THRESHOLD`.
 *   3. `version-mismatch` is a hard, one-shot disconnect with no strike —
 *      a client speaking the wrong protocol version is not a malformed-
 *      input attack; it's a different protocol.
 *   4. The size cap (64 KB) is enforced in `ws.ts` *before* `processRawFrame`
 *      runs, so an oversized envelope never enters JSON.parse territory.
 *      That path also routes through `noteInvalidInput` for symmetry.
 *   5. Rate-limit violations (general bucket exhaustion OR chat-limiter
 *      rejection) feed `noteRateViolation`, which manages a separate
 *      sliding-window flood tracker. Three violations within 10 seconds
 *      drop the connection with code 4009.
 */
import {
  PROTOCOL_VERSION,
  decodeEnvelope,
  parseMessage,
  ProtocolError,
  type Envelope,
  type MessageType,
} from "@shared/protocol/index.js";

import type { Connection, ConnectionRegistry } from "./ws.connection.js";
import type {
  AuthResolver,
  JoinResolver,
  LogoutResolver,
  WarpResolver,
  WsHandleOptions,
} from "./ws.js";
import { closeFloodedConnection, sendError, sendFrame } from "./ws.dispatch.helpers.js";
import {
  onAuth,
  onChat,
  onDrop,
  onEnterShip,
  onExitShip,
  onHello,
  onInput,
  onInteract,
  onJoinSystem,
  onLogout,
  onPickup,
  onWarp,
} from "./ws.handlers.js";

// ---------------------------------------------------------------------------
// Constants — exported so tests can reference them without hard-coding
// ---------------------------------------------------------------------------

/**
 * Maximum consecutive malformed-input strikes before the server drops the
 * connection with a WebSocket close code 1008. Covers invalid envelopes,
 * per-type payload validation failures, and unknown message types.
 *
 * Bumped from the TASK-9 value of 10 to 50 per TASK-64 acceptance
 * criteria ("drop at 50") so a transient client-side bug doesn't sever
 * the player mid-game.
 */
export const INVALID_DROP_THRESHOLD = 50;

/**
 * Per-connection cap on inbound message *bytes* (TASK-64 acceptance:
 * "cap JSON parse size at 64 KB per message at the ws layer"). Enforced
 * in `ws.ts` *before* `JSON.parse` so an oversized payload never crashes
 * the parser. The number lives here so the dispatcher and the size-cap
 * check share one source of truth.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// noteInvalidInput — centralised invalid-frame handler
// ---------------------------------------------------------------------------

/**
 * Route for *any* malformed inbound frame: envelope-level failures,
 * per-type validation failures, unknown message types, and the oversize
 * cap enforced in `ws.ts`.
 *
 * Behaviour:
 *   1. Send a single structured `error` frame with `{ code, message }`.
 *      No raw payload data is echoed back — only the code + a generic
 *      message — so a malicious peer can't use our error channel to
 *      probe server state.
 *   2. Increment `conn.invalidCount`. Persistence is intentional so a
 *      single chatty misbehaving client doesn't blow past the cap.
 *   3. When `invalidCount >= INVALID_DROP_THRESHOLD`, force-close the
 *      socket with WS close code 1008 ("policy violation") and remove
 *      the connection from the registry. The hook in `ws.ts` will
 *      transition the state to `closed`.
 */
export function noteInvalidInput(
  conn: Connection,
  registry: ConnectionRegistry,
  code: string,
  message: string,
): void {
  sendError(conn, code, message);
  conn.invalidCount += 1;
  if (conn.invalidCount >= INVALID_DROP_THRESHOLD) {
    try {
      conn.ws.close(1008, "too-many-invalid-messages");
    } catch {
      // socket already torn down; the close handler will clean up.
    }
    conn.state = "closed";
    registry.remove(conn.ws);
  }
}

// ---------------------------------------------------------------------------
// noteRateViolation — TASK-65 escalation helper
// ---------------------------------------------------------------------------

/**
 * Route for *any* rate-limit violation: general bucket exhaustion OR
 * chat-limiter rejection. Independent of `noteInvalidInput`'s
 * validation-strike counter so a flooding client doesn't get bucketed
 * with a client sending malformed JSON.
 *
 * Behaviour:
 *   1. Send a single structured `error` frame with `{ code, message }`.
 *   2. Push `now` into the per-connection `FloodTracker` sliding window.
 *   3. When the window reaches `FLOOD_VIOLATION_THRESHOLD`, force-close
 *      the socket with WS code 4009 + reason `flooded` and remove the
 *      connection from the registry via `closeFloodedConnection`.
 *
 * Returns `true` if the connection was dropped during this call so the
 * caller can short-circuit further processing.
 */
export function noteRateViolation(
  conn: Connection,
  _registry: ConnectionRegistry,
  _options: WsHandleOptions,
  now: number,
  code: string,
  message: string,
): boolean {
  sendError(conn, code, message);
  if (conn.floodTracker.noteViolation(now)) {
    closeFloodedConnection(conn, _registry);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// processRawFrame — the single entry point for an inbound text frame
// ---------------------------------------------------------------------------

/**
 * Process one inbound frame. Public for unit testing; not part of the
 * stable server API. `raw` is the JSON string the client sent.
 *
 * Failure paths feed into a unified error channel:
 *   - Rate-limit violations → `noteRateViolation` (sliding-window
 *     counter, 3 in 10 s → close 4009).
 *   - Validation/envelope failures → `noteInvalidInput` (lifetime
 *     counter, 50 → close 1008).
 *   - Version mismatch → immediate close 1002 (no counter; it's a
 *     different protocol, not a malformed-input attack).
 *
 * The rate-limit gate runs first so excess frames are dropped as
 * cheaply as possible — they never reach `JSON.parse`.
 */
export async function processRawFrame(
  conn: Connection,
  registry: ConnectionRegistry,
  authResolver: AuthResolver,
  joinResolver: JoinResolver,
  logoutResolver: LogoutResolver,
  warpResolver: WarpResolver,
  options: WsHandleOptions,
  raw: string,
): Promise<void> {
  const now = (options.now ?? Date.now)();

  // Step 0: per-connection token-bucket gate (TASK-65). An empty bucket
  // turns into a structured `rate-limited` error followed by no further
  // processing. Excess frames cost only one cheap arithmetic op; we
  // don't get to JSON.parse.
  if (!conn.bucket.take(now)) {
    if (noteRateViolation(conn, registry, options, now, "rate-limited", "Message rate exceeded")) {
      return;
    }
    return;
  }

  // Step 1: envelope decode.
  let envelope: Envelope;
  try {
    envelope = decodeEnvelope(raw);
  } catch (err) {
    if (err instanceof ProtocolError) {
      // Per spec, envelope-shape failures surface as `invalid-message`
      // (clients only see one validation failure code). The underlying
      // code ("invalid-envelope") is logged at debug level elsewhere
      // when we wire up structured logging in a later task.
      noteInvalidInput(conn, registry, "invalid-message", err.message);
      return;
    }
    throw err;
  }

  // Step 2: envelope-level version check (independent of per-type payloads).
  // Version mismatch is a one-shot disconnect — NOT a strike. A client
  // speaking the wrong protocol is a different protocol, not a malformed-
  // input attack.
  if (envelope.v !== PROTOCOL_VERSION) {
    sendError(
      conn,
      "version-mismatch",
      `Expected protocol version ${PROTOCOL_VERSION}, got ${envelope.v}`,
    );
    conn.ws.close(1002, "version-mismatch");
    conn.state = "closed";
    registry.remove(conn.ws);
    return;
  }

  // Step 3: payload validation.
  let parsed: { type: MessageType; payload: unknown };
  try {
    parsed = parseMessage(envelope.type, envelope.payload);
  } catch (err) {
    if (err instanceof ProtocolError) {
      // unknown-type and invalid-message BOTH count toward the strike
      // counter per TASK-64 ("increment per-connection invalid counter").
      // The error code we forward to the client matches `err.code` so the
      // client can distinguish "bad type" from "bad body" in its own logs.
      noteInvalidInput(conn, registry, err.code, err.message);
      return;
    }
    throw err;
  }

  // Step 4: dispatch.
  await dispatch(
    conn,
    registry,
    authResolver,
    joinResolver,
    logoutResolver,
    warpResolver,
    options,
    parsed.type,
    parsed.payload,
  );
}

// ---------------------------------------------------------------------------
// Message dispatch — enforces handshake order + per-type handlers
// ---------------------------------------------------------------------------

/**
 * Dispatch a validated frame to the right handler. The handshake-state
 * machine lives here: only frames that are legal in the current state
 * are processed; out-of-order frames get an `unauthenticated` error.
 *
 * `ping`/`pong` are legal at every state because keepalive must work
 * regardless of where the client is in the handshake.
 *
 * Out-of-order handshake frames (`unauthenticated` errors) deliberately
 * DO NOT count toward the strike counter — a client trying to skip ahead
 * is forging state, not spraying malformed input, so we want the operator
 * to see the precise `unauthenticated` code in their log without risk
 * of the connection being terminated by something that looks like
 * "too many invalid inputs".
 */
async function dispatch(
  conn: Connection,
  registry: ConnectionRegistry,
  authResolver: AuthResolver,
  joinResolver: JoinResolver,
  logoutResolver: LogoutResolver,
  warpResolver: WarpResolver,
  options: WsHandleOptions,
  type: MessageType,
  payload: unknown,
): Promise<void> {
  // Keepalive frames are always legal.
  if (type === "ping") {
    const p = payload as { t: number };
    sendFrame(conn, "pong", { t: p.t });
    return;
  }
  if (type === "pong") {
    conn.lastSeenAt = (options.now ?? Date.now)();
    return;
  }

  switch (conn.state) {
    case "hello":
      if (type !== "hello") {
        sendError(conn, "unauthenticated", `Expected hello, got ${type}`);
        return;
      }
      await onHello(conn, registry, options, payload);
      return;

    case "authed":
      // After hello, the client must send `auth`. Other types get an
      // `unauthenticated` error so a malicious client can't bypass auth.
      if (type !== "auth") {
        sendError(conn, "unauthenticated", `Expected auth, got ${type}`);
        return;
      }
      await onAuth(conn, registry, authResolver, options, payload);
      return;

    case "joined":
      // In-system clients may send anything except handshake bootstrap
      // types. Re-sending those is silently ignored (idempotent).
      if (type === "hello" || type === "auth") {
        return;
      }
      if (type === "join_system") {
        // Subsequent join_system frames (e.g. after a warp, future TASK-8)
        // are accepted and treated as re-join of the given system.
        await onJoinSystem(conn, joinResolver, options, payload);
        return;
      }
      if (type === "warp") {
        // TASK-8: inter-system travel. The handler drives the
        // galaxy router to remove the conn from the source shard
        // and join it to the target shard; on success the client
        // receives a `warp_arrived` frame, on failure a structured
        // `error` frame carrying the wire code. The connection
        // stays alive across the warp so the player can re-try
        // (or pick a different system).
        await onWarp(conn, warpResolver, options, payload);
        return;
      }
      if (type === "logout") {
        // TASK-66: revoke every session row for this player and close.
        await onLogout(conn, registry, logoutResolver, options, payload);
        return;
      }
      if (type === "chat") {
        // TASK-65: chat-specific rate limit (2 s gap, 280 chars,
        // 10 / 30 s window). On accept the message is silently consumed;
        // TASK-16 wires up broadcast + history. On rejection the chat
        // limiter's reason is surfaced as a `rate-limited` error frame
        // and the violation is counted toward `FloodTracker` so chat
        // spam escalation behaves identically to general flooding.
        onChat(conn, registry, options, payload);
        return;
      }
      if (type === "input") {
        // TASK-17: route the player input into the per-connection
        // seq-protected slot on the player's current shard. The
        // shard's input queue enforces strict-monotone seq + latest-
        // wins semantics (TASK-13) and the next entity_update carries
        // `lastAppliedSeq[playerId]` so the client can reconcile.
        onInput(conn, options, payload);
        return;
      }
      if (type === "exit_ship") {
        // TASK-31: player-initiated egress from docked ship to
        // character. Handler validates the ship is docked, mints
        // a character entity, rebinds the connection, and forces a
        // broadcast. Rejection paths surface as structured error
        // frames (`not-docked`, `no-ship`); success is silent
        // because the *next* snapshot is the confirmation.
        onExitShip(conn, options, payload);
        return;
      }
      if (type === "enter_ship") {
        // TASK-35: player-initiated re-entry from character to
        // ship. The reverse of `exit_ship`: validates the player
        // is on foot, finds the associated ship via the
        // character's `onShipId`, enforces ownership + the 5 m
        // proximity radius + the 1 u/s velocity cap, then rebinds
        // the connection to the ship. Success pushes an
        // `enter_ship_ok` ack so the owning client can swap the
        // controls + camera synchronously. Rejection surfaces as
        // `not-owner` / `ship-moving` / `out-of-range` /
        // `already-in-ship` / `invalid-message`.
        onEnterShip(conn, options, payload);
        return;
      }
      if (type === "interact") {
        // TASK-33: proximity interaction. The handler validates
        // range + regime + target existence against the shard
        // registry and dispatches via `InteractableRegistry`.
        // Success: emit `interact_ok` (and possibly a `ui_open` for
        // dock terminals). Failure: emit a structured `error` with
        // one of `out-of-range`, `wrong-regime`, `not-found`.
        onInteract(conn, options, payload);
        return;
      }
      if (type === "pickup") {
        // TASK-34: direct pickup path. Routes through the same
        // `handlePickup` math as the `interact` registry but is a
        // separate frame so the client can fire a pickup without
        // the prompt UI (e.g. a quick-slot hotkey).
        await onPickup(conn, options, payload);
        return;
      }
      if (type === "drop") {
        // TASK-34: drop on foot. Removes the resource from the
        // player's inventory and spawns a ground-item entity at the
        // character's position (TASK-34 acceptance: ground items
        // are visible to all players in the system via the snapshot).
        await onDrop(conn, options, payload);
        return;
      }
      // Future tasks route `mine`, `sell`, etc. to the system
      // shard. TASK-9 / TASK-65 accept them silently — the connection stays alive.
      return;

    case "closed":
      return;
  }
  void registry; // (silence unused-param if the switch above is exhaustive)
}

// ---------------------------------------------------------------------------
// Re-export constants so callers can reference them via a single import
// ---------------------------------------------------------------------------

export { PROTOCOL_VERSION };
