/**
 * Per-frame message routing for the Drift WebSocket server (TASK-9 + TASK-64).
 *
 * Extracted from `ws.ts` so the state machine + per-handler logic can
 * be exercised by tests with a stubbed `Connection`. The `ws.ts` module
 * owns the WebSocket lifecycle; this module owns what happens once a
 * frame has been read off the wire.
 *
 * Public API (kept stable so tests can drive it directly):
 *   - `processRawFrame(conn, registry, authResolver, joinResolver, options, raw)`
 *   - `noteInvalidInput(conn, registry, code, message)` — exported so the
 *     size-cap check in `ws.ts` can route through the same strike logic
 *     without duplicating it.
 *   - the per-state handlers (`onHello`, `onAuth`, `onJoinSystem`) are
 *     only used internally; the entry point is `processRawFrame`.
 *
 * State machine:
 *   hello  ──hello──▶  authed  ──auth──▶  joined
 *                                            │
 *                                       ──join_system──▶  joined (with systemId)
 *
 * Validation policy (TASK-64):
 *   1. Envelope decode (`decodeEnvelope`) uses `z.safeParse` and returns
 *      a `ProtocolError("invalid-envelope")` on shape mismatch / non-JSON.
 *      We forward these as `invalid-message` (per the spec: clients only
 *      see one invalid-input code) and bump the strike counter.
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
 */
import {
  PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  parseMessage,
  ProtocolError,
  type Envelope,
  type MessageType,
} from "@shared/protocol/index.js";

import type { Connection, ConnectionRegistry, WsConnectionState } from "./ws.connection.js";
import { snapshotConnection } from "./ws.connection.js";
import type { AuthResolver, JoinResolver, WsHandleOptions } from "./ws.js";

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
// processRawFrame — the single entry point for an inbound text frame
// ---------------------------------------------------------------------------

/**
 * Process one inbound frame. Public for unit testing; not part of the
 * stable server API. `raw` is the JSON string the client sent.
 *
 * All three failure paths (bad envelope, version mismatch, bad payload)
 * feed into `noteInvalidInput` (or, for version mismatch, an immediate
 * disconnect) so the strike accounting has a single source of truth.
 */
export async function processRawFrame(
  conn: Connection,
  registry: ConnectionRegistry,
  authResolver: AuthResolver,
  joinResolver: JoinResolver,
  options: WsHandleOptions,
  raw: string,
): Promise<void> {
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
  await dispatch(conn, registry, authResolver, joinResolver, options, parsed.type, parsed.payload);
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
      // Future tasks route `chat`, `input`, `warp`, etc. to the system
      // shard. TASK-9 accepts them silently — the connection stays alive.
      return;

    case "closed":
      return;
  }
  void registry; // (silence unused-param if the switch above is exhaustive)
}

// ---------------------------------------------------------------------------
// Per-state handlers
// ---------------------------------------------------------------------------

async function onHello(
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

async function onAuth(
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

async function onJoinSystem(
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
// Server-only outbound helpers
// ---------------------------------------------------------------------------

function sendFrame(conn: Connection, type: MessageType, payload: unknown): void {
  if (conn.ws.readyState !== conn.ws.OPEN) return;
  conn.ws.send(encodeEnvelope(type, payload));
}

function sendError(conn: Connection, code: string, message: string): void {
  if (conn.ws.readyState !== conn.ws.OPEN) return;
  conn.ws.send(encodeEnvelope("error", { code, message }));
}

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

// ---------------------------------------------------------------------------
// Re-export constants so callers can reference them via a single import
// ---------------------------------------------------------------------------

export { PROTOCOL_VERSION };
