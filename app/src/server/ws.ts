/**
 * WebSocket upgrade handler for the Drift server (TASK-9 + TASK-64).
 *
 * Public surface:
 *   - `attachWs(app, wsPath, options)` — wires a `ws.Server` to a Fastify
 *     HTTP server on the configured path. Returns a `WsHandle` whose
 *     `close()` resolves once every socket has been terminated.
 *   - `WsHandle`, `WsHandleOptions`, `WsKeepaliveConfig` — types
 *     referenced by the live server.
 *   - `JoinResolver`, `AuthResolver` — pluggable interfaces for future
 *     tasks to swap in real callsign-uniqueness (TASK-10) and system
 *     routing (TASK-11) implementations.
 *
 * The handshake state machine, per-type handlers and default resolvers
 * live in sibling modules:
 *   - `./ws.connection.ts` — `Connection` + `ConnectionRegistry`
 *   - `./ws.dispatch.ts`   — `processRawFrame`, dispatch, handlers,
 *                              `noteInvalidInput` (the size-cap gate)
 *   - `./ws.resolvers.ts`  — `defaultAuthResolver`, `defaultJoinResolver`
 *
 * State machine:
 *   hello  ──hello──▶  authed  ──auth──▶  joined
 *                                            │
 *                                       ──join_system──▶  joined (with systemId)
 *
 * Keepalive:
 *   - `ws.ping()` is sent every `pingIntervalMs` (default 15s).
 *   - Connections silent for longer than `pongTimeoutMs` (default 45s)
 *     are terminated on the next keepalive tick.
 *
 * Inbound validation (TASK-64):
 *   - Every inbound text frame is checked against `maxMessageBytes`
 *     (default 64 KB) before JSON.parse is called. Over-sized frames
 *     route through `noteInvalidInput` for unified strike accounting
 *     and 1008 close-on-threshold behaviour.
 *   - `ws.Server`'s native `maxPayload` option is left at the library
 *     default (100 MB) so our own checker can emit a structured
 *     `invalid-message` error rather than a silent 1009 close.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { FastifyInstance } from "fastify";

import {
  ConnectionRegistry,
  snapshotConnection,
  type Connection,
  type WsConnectionRecord,
  type WsConnectionState,
} from "./ws.connection.js";
import {
  processRawFrame,
  noteInvalidInput,
  INVALID_DROP_THRESHOLD,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "./ws.dispatch.js";
import { defaultAuthResolver, defaultJoinResolver, defaultLogoutResolver } from "./ws.resolvers.js";
import {
  ChatLimiter,
  FloodTracker,
  TokenBucket,
  CHAT_MAX_LEN,
  CHAT_MIN_GAP_MS,
  CHAT_WINDOW_MAX,
  CHAT_WINDOW_MS,
  FLOOD_VIOLATION_THRESHOLD,
  FLOOD_WINDOW_MS,
  GENERAL_BURST,
  GENERAL_RATE_LIMIT,
} from "./ratelimit.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Snapshot the server sends back to a successfully-joined client. Kept as
 * an open shape so future tasks (TASK-11/13/15) can add fields without
 * touching this file.
 */
export interface JoinResolverResult {
  /** Canonical system id (echoed back to the client). */
  systemId: string;
  /** Entities visible at join time (other players, AI ships, wrecks). */
  entities: unknown[];
  /** Resource nodes the client should hydrate (TASK-5 surface + TASK-37). */
  nodes: unknown[];
  /** Recent chat history (last 100 lines, TASK-16). */
  chat: unknown[];
  /** Callsigns of other players in the system. */
  players: unknown[];
  /** Server tick rate the client should interpolate at. */
  serverTickHz: number;
  /** Tick number of the snapshot (so the client can ack it). */
  snapshotTick: number;
}

/** Resolver function injected by `attachWs` so future tasks can swap it. */
export type JoinResolver = (systemId: string, callsign: string) => Promise<JoinResolverResult>;

/**
 * Auth resolver — turns the auth payload into a playerId/callsign pair.
 * For TASK-9 we ship a permissive stub that accepts any well-formed auth
 * frame; TASK-10 will replace it with real callsign uniqueness checks.
 */
export type AuthResolver = (
  payload: unknown,
) => Promise<{ playerId: string; callsign: string; tokenExpiresAt: number }>;

/**
 * Logout resolver — TASK-66. Deletes *all* session rows for the player
 * identified by `playerId`, returning the count so callers can confirm
 * the revoke actually landed. The default implementation wires to the
 * live repository; production has its own.
 */
export type LogoutResolver = (playerId: string) => Promise<{ revoked: number; callsign: string }>;

/** Mutable handle returned by `attachWs`. */
export interface WsHandle {
  /** Underlying `ws.Server`; exposed for tests and graceful shutdown. */
  wss: WebSocketServer;
  /** Close every active socket and stop accepting new ones. */
  close: () => Promise<void>;
  /** Snapshot of live connection state for tests/diagnostics. */
  connections: () => WsConnectionRecord[];
}

/** Tunable keepalive knobs. Tests override these to avoid real timers. */
export interface WsKeepaliveConfig {
  /** How often (ms) the server emits a `ping` frame to idle connections. */
  pingIntervalMs: number;
  /** Connections silent for longer than this (ms) are terminated. */
  pongTimeoutMs: number;
}

/** Options accepted by `attachWs` (extensible without breaking callers). */
export interface WsHandleOptions {
  /** Resolve `auth` frames to a player. Defaults to a stub. */
  authResolver?: AuthResolver;
  /** Resolve `join_system` frames to a snapshot. Defaults to a stub. */
  joinResolver?: JoinResolver;
  /**
   * Resolve `logout` frames (TASK-66). Default rejects every logout with
   * `unauthenticated`. Production wires this to `buildLogoutResolver(...)`
   * so the WS `logout` message revokes all of the player's sessions.
   */
  logoutResolver?: LogoutResolver;
  /** Keepalive tunables. Tests usually override these. */
  keepalive?: Partial<WsKeepaliveConfig>;
  /**
   * Cap on inbound message *bytes* (TASK-64 acceptance criteria).
   * Frames exceeding this size are rejected with `invalid-message` and
   * counted toward the strike threshold without ever reaching
   * `JSON.parse`. Defaults to 64 KB. Set this to a very large value in
   * tests that intentionally exercise oversize behaviour.
   */
  maxMessageBytes?: number;
  /** Clock for `Date.now()` — tests inject a fake clock. */
  now?: () => number;
  /** Hook fired when a connection transitions to a new state. */
  onStateChange?: (record: WsConnectionRecord, previous: WsConnectionState) => void;
}

// ---------------------------------------------------------------------------
// Constants — exported so tests can reference them without hard-coding
// ---------------------------------------------------------------------------

/** Default ping interval (ms) — matches the TASK-9 acceptance criterion. */
export const DEFAULT_PING_INTERVAL_MS = 15_000;

/** Default pong timeout (ms) — matches the TASK-9 acceptance criterion. */
export const DEFAULT_PONG_TIMEOUT_MS = 45_000;

/**
 * Re-export from `ws.dispatch.ts` so callers can pull every protocol-level
 * constant from this module's barrel.
 */
export { INVALID_DROP_THRESHOLD, MAX_MESSAGE_BYTES, PROTOCOL_VERSION };

// ---------------------------------------------------------------------------
// attachWs
// ---------------------------------------------------------------------------

/**
 * Attach a `ws.Server` to `app.server.httpServer` on `wsPath`.
 *
 * Returns a handle whose `close()` resolves once every socket has been
 * terminated, so the caller can `await` it during graceful shutdown.
 *
 * The handler is intentionally side-effect free beyond attaching the
 * upgrade listener: tests can `attachWs` on a Fastify instance they
 * control, exercise the protocol, then `await handle.close()`.
 */
export function attachWs(
  app: FastifyInstance,
  wsPath: string,
  options: WsHandleOptions = {},
): WsHandle {
  if (!app.server) {
    throw new Error("Fastify app is not listening; cannot attach WebSocket server.");
  }
  // We deliberately leave the underlying `ws.Server.maxPayload` at its
  // 100 MB library default so we can emit our own structured
  // `invalid-message` error below instead of a silent 1009 close.
  const wss = new WebSocketServer({ noServer: true });
  const registry = new ConnectionRegistry();

  const authResolver = options.authResolver ?? defaultAuthResolver;
  const joinResolver = options.joinResolver ?? defaultJoinResolver;
  const logoutResolver = options.logoutResolver ?? defaultLogoutResolver;
  const pingIntervalMs = options.keepalive?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pongTimeoutMs = options.keepalive?.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const now = options.now ?? Date.now;

  app.server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    if (!url.startsWith(wsPath)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const conn: Connection = {
      ws,
      state: "hello",
      playerId: null,
      callsign: null,
      systemId: null,
      invalidCount: 0,
      lastSeenAt: now(),
      lastPingedAt: 0,
      // TASK-65: per-connection rate-limit state. Each subclass uses the
      // shared `now` clock so unit tests can advance time deterministically
      // and observe bucket / tracker / limiter behavior.
      bucket: new TokenBucket(GENERAL_RATE_LIMIT, GENERAL_BURST, now),
      floodTracker: new FloodTracker(FLOOD_WINDOW_MS, FLOOD_VIOLATION_THRESHOLD, now),
      chatLimiter: new ChatLimiter(
        CHAT_MIN_GAP_MS,
        CHAT_WINDOW_MS,
        CHAT_WINDOW_MAX,
        CHAT_MAX_LEN,
        now,
      ),
    };
    registry.add(ws, conn);

    // ws handles ping/pong at the protocol level; we want to react to the
    // *application-level* pongs we send (and any inbound data) for the
    // 45-second idle timeout, so we also watch for `pong` events here.
    ws.on("pong", () => {
      const c = registry.get(ws);
      if (c) c.lastSeenAt = now();
    });

    ws.on("error", () => {
      // Swallow per-socket errors; the server keeps running.
    });

    ws.on("close", () => {
      const c = registry.get(ws);
      if (c) c.state = "closed";
      registry.remove(ws);
    });

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const c = registry.get(ws);
      if (!c || c.state === "closed") return;
      const buf = rawToBuffer(raw);
      // Size cap (TASK-64 acceptance): reject oversize frames with a
      // structured `invalid-message` and route through `noteInvalidInput`
      // so the strike counter increments toward INVALID_DROP_THRESHOLD.
      // We measure *bytes*, not characters, so a UTF-8 multi-byte payload
      // can't sneak past the gate.
      if (buf.byteLength > maxMessageBytes) {
        noteInvalidInput(
          c,
          registry,
          "invalid-message",
          `Message exceeds ${maxMessageBytes}-byte limit`,
        );
        return;
      }
      c.lastSeenAt = now();
      const text = buf.toString("utf8");
      void processRawFrame(c, registry, authResolver, joinResolver, logoutResolver, options, text);
    });
  });

  // Keepalive interval. Uses setInterval (not setTimeout) so a stalled
  // socket that comes back briefly doesn't reset the timer — instead, the
  // pong timeout handles liveness. The interval is cleared on close().
  const keepaliveTimer = setInterval(() => {
    const cutoff = now() - pongTimeoutMs;
    for (const c of registry.values()) {
      if (c.state === "closed") continue;
      if (c.lastSeenAt < cutoff) {
        try {
          c.ws.terminate();
        } catch {
          // already closed
        }
        c.state = "closed";
        registry.remove(c.ws);
        continue;
      }
      try {
        c.ws.ping();
        c.lastPingedAt = now();
      } catch {
        // socket already torn down; the close handler will clean up.
      }
    }
  }, pingIntervalMs);
  // Don't block Node shutdown.
  keepaliveTimer.unref?.();

  return {
    wss,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(keepaliveTimer);
        for (const c of registry.values()) {
          try {
            c.ws.terminate();
          } catch {
            // already closed
          }
          c.state = "closed";
          registry.remove(c.ws);
        }
        wss.close(() => resolve());
      }),
    connections: () => Array.from(registry.values()).map((c) => snapshotConnection(c)),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce the various shapes `ws` can deliver for a message into a single
 * `Buffer`. The WebSocket library hands us `Buffer | ArrayBuffer | Buffer[]`
 * depending on whether the frame was binary/text and whether the message
 * arrived in chunks. All three are valid; we just normalise.
 */
function rawToBuffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return raw;
}
