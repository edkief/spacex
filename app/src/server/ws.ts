import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { Duplex } from 'stream';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'http';

import {
  DROP_AFTER_MS,
  INVALID_MESSAGE_DROP_LIMIT,
  MAX_MESSAGE_BYTES,
  PING_INTERVAL_MS,
  PROTOCOL_ERRORS,
  PROTOCOL_VERSION,
  UNKNOWN_TYPE_DROP_LIMIT,
  decodeMessage,
  encodeMessage,
  parseMessage,
} from '@shared/protocol';
import type { MessageType } from '@shared/protocol';
import type { AuthPayload, PresenceEntry, StateSnapshot } from '@shared/protocol/schemas';
import { CHAT_MAX_CHARS, CHAT_WINDOW_MAX, CHAT_WINDOW_MS, sanitizeChatText } from '@shared/chat';
import type { Repository } from '@server/db/repo';
import {
  ChatLimiter,
  MESSAGE_BURST,
  MESSAGE_RATE,
  TokenBucket,
  ViolationTracker,
} from '@server/ratelimit';

/**
 * WS connection lifecycle (TASK-9): handshake state machine
 * hello → auth → join_system, structured {code, message} errors,
 * unknown-type counter (drop at 10) and 15 s/45 s ping-pong keepalive.
 */

export interface AuthOutcome {
  ok: boolean;
  playerId?: string;
  callsign?: string;
  message?: string;
}

export type Authenticate = (payload: AuthPayload) => Promise<AuthOutcome>;

export type EnterOutcome =
  | { ok: true; snapshot: StateSnapshot }
  | { ok: false; code: 'system-full' | 'system-not-found'; message: string };

/**
 * The joining player, as seen by the gateway. `send` delivers serialized
 * protocol frames to this connection (the router registers it on the shard
 * so the 10 Hz snapshots reach the new player, TASK-11).
 */
export interface GatewayPlayer {
  playerId: string;
  callsign: string;
  send?: (buffer: string) => void;
}

export interface SystemGateway {
  enterSystem(systemId: string, player: GatewayPlayer): Promise<EnterOutcome>;
  leaveSystem?(systemId: string, player: GatewayPlayer): void | Promise<void>;
}

export type ConnStage = 'hello' | 'auth' | 'authed';

export interface Conn {
  socket: WebSocket;
  stage: ConnStage;
  playerId: string | null;
  callsign: string | null;
  /**
   * The raw token the connection authenticated with (memory only — never
   * stored or logged), so a 'logout' can revoke it (TASK-66).
   */
  token: string | null;
  systemId: string | null;
  unknownTypes: number;
  /** Rejected (undecodable or schema-failing) messages; drop at 50 (TASK-64). */
  invalidMessages: number;
  /** Inbound token bucket: 20 msg/s, burst 40 (TASK-65). */
  bucket: TokenBucket;
  /**
   * Per-connection chat limiter, TASK-16 rules (reusing the TASK-65 limiter):
   * 200 chars, at most 5 messages per 10 s window, no min gap (gameplay
   * chatter stays fluid; the window is the spam bound).
   */
  chatLimiter: ChatLimiter;
  /** Rate-limit violations; 3 within 10 s closes the socket (TASK-65). */
  violations: ViolationTracker;
  lastActivityAt: number;
  /** Handlers are async (auth, gateway); a per-connection chain preserves order. */
  queue: Promise<void>;
}

/** Types that only make sense while joined to a system. */
const SYSTEM_SCOPED: ReadonlySet<string> = new Set([
  'input',
  'warp',
  'interact',
  'mine',
  'sell',
  'buy_ship',
  'set_livery',
  'exit_ship',
  'enter_ship',
  'repair',
  'chat',
  'target_update',
]);

/**
 * Test/dev fallback only: production wiring (index.ts) passes
 * createTokenAuthenticate from @server/auth/session instead (TASK-10).
 */
export const devAuthenticate: Authenticate = async (payload) => {
  if (payload.callsign) {
    return { ok: true, playerId: randomUUID(), callsign: payload.callsign };
  }
  if (payload.token) {
    return { ok: true, playerId: randomUUID(), callsign: `anon-${payload.token.slice(0, 8)}` };
  }
  return { ok: false, message: 'auth requires a token or a callsign' };
};

/**
 * Gateway over the system_registry table: unknown ids → system-not-found,
 * known ids → empty snapshot (live shards publish real state in TASK-12).
 */
export function createRegistryGateway(repo: Repository): SystemGateway {
  return {
    async enterSystem(systemId) {
      const system = await repo.findSystem(systemId);
      if (!system) {
        return { ok: false, code: 'system-not-found', message: `system ${systemId} not found` };
      }
      return {
        ok: true,
        snapshot: { systemId, entities: [], nodes: [], chat: [], players: [] },
      };
    },
  };
}

function send(conn: Conn, type: MessageType, payload: unknown): void {
  if (conn.socket.readyState === WebSocket.OPEN) {
    conn.socket.send(encodeMessage(type, payload as never));
  }
}

function sendError(conn: Conn, code: string, message: string): void {
  send(conn, 'error', { code, message });
}

function presenceEntry(conn: Conn): PresenceEntry {
  return { playerId: conn.playerId ?? '', callsign: conn.callsign ?? '' };
}

export interface AttachWebSocketOptions {
  path: string;
  gateway: SystemGateway;
  authenticate?: Authenticate;
  /** Gameplay dispatch (shards wire in later tasks); validated messages only. */
  onGameMessage?: (conn: Conn, type: string, payload: unknown) => void;
  /** Called after a successful join_system (shards spawn the player's entity). */
  onJoinSystem?: (conn: Conn, systemId: string) => void | Promise<void>;
  /** Called when a joined connection closes (shards release the connection). */
  onLeaveSystem?: (conn: Conn, systemId: string) => void | Promise<void>;
  keepalive?: { pingIntervalMs?: number; dropAfterMs?: number };
  /** Revokes a token presented at auth (WS 'logout', TASK-66). */
  revokeToken?: (token: string) => boolean | void | Promise<boolean> | Promise<void>;
}

export interface WebSocketHandle {
  wss: WebSocketServer;
  connections: Set<Conn>;
  close(): Promise<void>;
}

export function attachWebSocket(
  server: FastifyInstance,
  options: AttachWebSocketOptions,
): WebSocketHandle {
  const authenticate = options.authenticate ?? devAuthenticate;
  const pingMs = options.keepalive?.pingIntervalMs ?? PING_INTERVAL_MS;
  const dropMs = options.keepalive?.dropAfterMs ?? DROP_AFTER_MS;

  // maxPayload must exceed MAX_MESSAGE_BYTES so oversized frames reach
  // onRawMessage and get a structured invalid-message instead of a bare 1009
  // policy close.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES * 32 });
  const connections = new Set<Conn>();

  function peersIn(systemId: string): Conn[] {
    const peers: Conn[] = [];
    for (const other of connections) {
      if (other.systemId === systemId) peers.push(other);
    }
    return peers;
  }

  async function handleMessage(conn: Conn, type: string, payload: unknown): Promise<void> {
    switch (type) {
      case 'hello': {
        if (conn.stage !== 'hello') {
          return sendError(conn, PROTOCOL_ERRORS.INVALID_MESSAGE, 'handshake already complete');
        }
        const v = (payload as { v: unknown }).v;
        if (v !== PROTOCOL_VERSION) {
          sendError(
            conn,
            PROTOCOL_ERRORS.VERSION_MISMATCH,
            `server speaks protocol v${PROTOCOL_VERSION}, got v${String(v)}`,
          );
          conn.socket.close(1002, 'version-mismatch');
          return;
        }
        conn.stage = 'auth';
        return;
      }
      case 'auth': {
        if (conn.stage === 'hello') {
          return sendError(conn, PROTOCOL_ERRORS.UNAUTHENTICATED, 'send hello first');
        }
        if (conn.stage === 'authed') {
          return sendError(conn, PROTOCOL_ERRORS.INVALID_MESSAGE, 'handshake already complete');
        }
        const result = await authenticate(payload as AuthPayload);
        if (!result.ok || !result.playerId || !result.callsign) {
          return sendError(
            conn,
            PROTOCOL_ERRORS.UNAUTHENTICATED,
            result.message ?? 'authentication failed',
          );
        }
        conn.playerId = result.playerId;
        conn.callsign = result.callsign;
        conn.token = (payload as AuthPayload).token ?? null;
        conn.stage = 'authed';
        return;
      }
      case 'join_system': {
        if (conn.stage !== 'authed') {
          return sendError(
            conn,
            PROTOCOL_ERRORS.UNAUTHENTICATED,
            'auth required before join_system',
          );
        }
        const targetSystemId = (payload as { systemId: string }).systemId;
        if (conn.systemId === targetSystemId) {
          return sendError(conn, PROTOCOL_ERRORS.INVALID_MESSAGE, 'already in a system');
        }
        const player: GatewayPlayer = {
          playerId: conn.playerId as string,
          callsign: conn.callsign as string,
          send: (buffer) => {
            if (conn.socket.readyState === WebSocket.OPEN) conn.socket.send(buffer);
          },
        };
        // Join the NEW system first: a failure (system-full / not-found)
        // leaves the player exactly where they were (TASK-11).
        const outcome = await options.gateway.enterSystem(targetSystemId, player);
        if (!outcome.ok) {
          return sendError(conn, outcome.code, outcome.message);
        }
        const previousSystemId = conn.systemId;
        conn.systemId = targetSystemId;
        if (previousSystemId) {
          // The new join succeeded: leave the old system now.
          for (const peer of peersIn(previousSystemId)) {
            send(peer, 'presence', { event: 'leave', player: presenceEntry(conn) });
          }
          void options.onLeaveSystem?.(conn, previousSystemId);
          void options.gateway.leaveSystem?.(previousSystemId, player);
        }
        for (const peer of peersIn(conn.systemId)) {
          if (peer === conn) continue; // peersIn now includes the joiner
          send(peer, 'presence', { event: 'join', player: presenceEntry(conn) });
        }
        send(conn, 'enter_system', { snapshot: outcome.snapshot });
        void options.onJoinSystem?.(conn, conn.systemId);
        return;
      }
      case 'logout': {
        // TASK-66: only an authenticated connection owns a token to revoke.
        if (conn.stage !== 'authed') {
          return sendError(conn, PROTOCOL_ERRORS.UNAUTHENTICATED, 'auth required before logout');
        }
        if (conn.token) await options.revokeToken?.(conn.token);
        // Clean close: the token is already revoked, no further handshake
        // with it can succeed.
        conn.socket.close(1000, 'logged-out');
        return;
      }
      case 'ping':
      case 'pong':
      case 'error':
        // Client-originated keepalive/error frames are valid but need no reply.
        return;
      default: {
        if (conn.stage !== 'authed') {
          return sendError(conn, PROTOCOL_ERRORS.UNAUTHENTICATED, 'auth required');
        }
        if (SYSTEM_SCOPED.has(type) && !conn.systemId) {
          return sendError(
            conn,
            PROTOCOL_ERRORS.UNAUTHENTICATED,
            `join a system before sending ${type}`,
          );
        }
        if (type === 'chat') {
          // TASK-16: schema already guaranteed a string of 1..200 chars after
          // trim; sanitize strips control / format characters, and a message
          // that is invisible after sanitization is invalid (not spam).
          const text = sanitizeChatText((payload as { text: string }).text);
          if (text.length < 1) {
            return rejectInvalid(conn, type, 'chat message is empty after sanitization');
          }
          const verdict = conn.chatLimiter.check(text);
          if (!verdict.ok) {
            return rejectRateLimited(conn, verdict.reason);
          }
          options.onGameMessage?.(conn, type, { text });
          return;
        }
        options.onGameMessage?.(conn, type, payload);
        return;
      }
    }
  }

  /**
   * Structured rejection of an invalid inbound message: counters toward the
   * per-connection drop limit and answers invalid-message without echoing the
   * raw payload (logged at debug with type + code only).
   */
  function rejectInvalid(conn: Conn, type: string | null, reason: string): void {
    conn.invalidMessages += 1;
    server.log.debug({ type, code: PROTOCOL_ERRORS.INVALID_MESSAGE }, 'rejected inbound message');
    sendError(conn, PROTOCOL_ERRORS.INVALID_MESSAGE, reason);
    if (conn.invalidMessages >= INVALID_MESSAGE_DROP_LIMIT) {
      conn.socket.terminate();
    }
  }

  /**
   * Rate-limit rejection: answers {code: 'rate-limited'} and drops the excess.
   * Every rejection counts toward escalation; 3 violations in 10 s closes the
   * socket with 4009 'flooded' (TASK-65).
   */
  function rejectRateLimited(conn: Conn, reason: string): void {
    server.log.debug({ code: PROTOCOL_ERRORS.RATE_LIMITED, reason }, 'dropped inbound message');
    sendError(conn, PROTOCOL_ERRORS.RATE_LIMITED, reason);
    if (conn.violations.record()) {
      conn.socket.close(4009, 'flooded');
    }
  }

  function onRawMessage(conn: Conn, data: Buffer): void {
    conn.lastActivityAt = Date.now();
    if (!conn.bucket.take()) {
      return rejectRateLimited(conn, `message rate limit: at most ${MESSAGE_RATE} msg/s`);
    }
    if (data.length > MAX_MESSAGE_BYTES) {
      return rejectInvalid(conn, null, `message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }
    const decoded = decodeMessage(data);
    if (!decoded.ok) {
      return rejectInvalid(conn, null, decoded.message);
    }
    const parsed = parseMessage(decoded.envelope.type, decoded.envelope.payload);
    if (!parsed.ok) {
      if (parsed.code === PROTOCOL_ERRORS.UNKNOWN_TYPE) {
        conn.unknownTypes += 1;
        sendError(conn, PROTOCOL_ERRORS.UNKNOWN_TYPE, parsed.message);
        if (conn.unknownTypes >= UNKNOWN_TYPE_DROP_LIMIT) {
          conn.socket.terminate();
        }
      } else {
        rejectInvalid(conn, decoded.envelope.type, parsed.message);
      }
      return;
    }
    // A handler throwing (e.g. a faulty gateway) closes the connection rather
    // than taking the server down.
    conn.queue = conn.queue.then(() =>
      handleMessage(conn, parsed.type, parsed.payload).catch(() => {
        conn.socket.close(1011, 'internal error');
      }),
    );
  }

  wss.on('connection', (socket) => {
    const conn: Conn = {
      socket,
      stage: 'hello',
      playerId: null,
      callsign: null,
      token: null,
      systemId: null,
      unknownTypes: 0,
      invalidMessages: 0,
      bucket: new TokenBucket(MESSAGE_RATE, MESSAGE_BURST),
      chatLimiter: new ChatLimiter(Date.now, {
        minGapMs: 0,
        maxChars: CHAT_MAX_CHARS,
        windowMs: CHAT_WINDOW_MS,
        windowMax: CHAT_WINDOW_MAX,
      }),
      violations: new ViolationTracker(),
      lastActivityAt: Date.now(),
      queue: Promise.resolve(),
    };
    connections.add(conn);

    socket.on('message', (data) => onRawMessage(conn, data as Buffer));
    socket.on('close', () => {
      connections.delete(conn);
      if (conn.systemId && conn.playerId && conn.callsign) {
        for (const peer of peersIn(conn.systemId)) {
          send(peer, 'presence', { event: 'leave', player: presenceEntry(conn) });
        }
        void options.onLeaveSystem?.(conn, conn.systemId);
        void options.gateway.leaveSystem?.(conn.systemId, {
          playerId: conn.playerId,
          callsign: conn.callsign,
        });
      }
    });
  });

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== options.path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.server.on('upgrade', upgrade);

  const keepalive = setInterval(() => {
    const now = Date.now();
    for (const conn of connections) {
      if (conn.socket.readyState !== WebSocket.OPEN) continue;
      if (now - conn.lastActivityAt > dropMs) {
        conn.socket.terminate();
        continue;
      }
      send(conn, 'ping', {});
    }
  }, pingMs);
  keepalive.unref();

  return {
    wss,
    connections,
    close: async () => {
      clearInterval(keepalive);
      server.server.off('upgrade', upgrade);
      for (const conn of connections) conn.socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
