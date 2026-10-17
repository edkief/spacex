/**
 * WebSocket upgrade handler for the Drift server (TASK-9).
 *
 * Public surface:
 *   - `attachWs(app, wsPath, options)` — wires a `ws.Server` to a Fastify
 *     HTTP server on the configured path. Returns a `WsHandle` whose
 *     `close()` resolves once every socket has been terminated.
 *   - `WsHandle`, `WsHandleOptions` — types referenced by the live server.
 *   - `JoinResolver`, `AuthResolver` — pluggable interfaces for future
 *     tasks to swap in real callsign-uniqueness (TASK-10) and system
 *     routing (TASK-11) implementations.
 *
 * The handshake state machine, per-type handlers and default resolvers
 * live in sibling modules:
 *   - `./ws.connection.ts` — `Connection` + `ConnectionRegistry`
 *   - `./ws.dispatch.ts`   — `processRawFrame`, dispatch, handlers
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
 *   - Unknown message types are counted; the 11th strike drops the
 *     connection (TASK-9 acceptance criterion).
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { FastifyInstance } from "fastify";

import {
  ConnectionRegistry,
  type Connection,
  type WsConnectionRecord,
  type WsConnectionState,
} from "./ws.connection.js";
import { processRawFrame, UNKNOWN_TYPE_DROP_THRESHOLD, PROTOCOL_VERSION } from "./ws.dispatch.js";
import { defaultAuthResolver, defaultJoinResolver } from "./ws.resolvers.js";

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
  /** Keepalive tunables. Tests usually override these. */
  keepalive?: Partial<WsKeepaliveConfig>;
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

// Re-export from dispatch.ts so callers can pull all the constants from one place.
export { UNKNOWN_TYPE_DROP_THRESHOLD, PROTOCOL_VERSION };

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
  const wss = new WebSocketServer({ noServer: true });
  const registry = new ConnectionRegistry();

  const authResolver = options.authResolver ?? defaultAuthResolver;
  const joinResolver = options.joinResolver ?? defaultJoinResolver;
  const pingIntervalMs = options.keepalive?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pongTimeoutMs = options.keepalive?.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
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
      unknownTypeCount: 0,
      lastSeenAt: now(),
      lastPingedAt: 0,
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
      c.lastSeenAt = now();
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf8")
              : raw.toString("utf8");
      void processRawFrame(c, registry, authResolver, joinResolver, options, text);
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
    connections: () =>
      Array.from(registry.values()).map((c) => ({
        state: c.state,
        playerId: c.playerId,
        callsign: c.callsign,
        systemId: c.systemId,
        unknownTypeCount: c.unknownTypeCount,
        lastSeenAt: c.lastSeenAt,
      })),
  };
}
