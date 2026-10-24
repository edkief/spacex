import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  decodeEnvelope,
  encodeMessage,
  parseMessage,
  PROTOCOL_VERSION,
  Envelope,
} from '../shared/protocol';
import { MessageSchemas, AuthSchema, JoinSystemSchema } from '../shared/protocol/schemas';
import { TokenBucket, ChatLimiter } from './ratelimit';
import { repo } from './db/repo';
import { verifyToken, hashToken } from './auth/token';

type ConnectionState = 'hello' | 'auth' | 'join_system' | 'active';

interface ConnectionContext {
  state: ConnectionState;
  playerId?: string;
  systemId?: string;
  unknownTypeCount: number;
  lastPong: number;
  bucket: TokenBucket;
  chatLimiter: ChatLimiter;
  violationTimestamps: number[];
}

export function setupWebSocketHandler(wss: WebSocketServer) {
  const connections = new Map<WebSocket, ConnectionContext>();
  const MAX_MESSAGE_SIZE = 64 * 1024;

  wss.on('connection', (ws) => {
    const ctx: ConnectionContext = {
      state: 'hello',
      unknownTypeCount: 0,
      lastPong: Date.now(),
      bucket: new TokenBucket(20, 40),
      chatLimiter: new ChatLimiter(),
      violationTimestamps: [],
    };
    connections.set(ws, ctx);

    ws.on('message', async (data) => {
      const dataLength = data instanceof Buffer ? data.length : (data as any).byteLength || 0;
      if (dataLength > MAX_MESSAGE_SIZE) {
        sendError(ws, 'invalid-message', 'Message too large');
        return;
      }
      const result = decodeEnvelope(data.toString());
      if (!result.success) {
        sendError(ws, 'invalid-message', result.error || 'Invalid envelope format');
        return;
      }
      try {
        await handleMessage(ws, ctx, result.data);
      } catch (err) {
        console.error('Error handling message:', err);
        sendError(ws, 'invalid-message', 'Internal server error');
      }
    });

    ws.on('close', () => {
      connections.delete(ws);
    });
  });

  // Keepalive loop
  setInterval(() => {
    const now = Date.now();
    connections.forEach((ctx, ws) => {
      if (now - ctx.lastPong > 45000) {
        ws.terminate();
        connections.delete(ws);
        return;
      }
      ws.send(encodeMessage('ping', { ts: now }));
    });
  }, 15000);

  function handleViolation(ws: WebSocket, ctx: ConnectionContext) {
    const now = Date.now();
    ctx.violationTimestamps.push(now);

    // Keep only last 10 seconds of violations
    ctx.violationTimestamps = ctx.violationTimestamps.filter((ts) => now - ts <= 10000);

    if (ctx.violationTimestamps.length >= 3) {
      ws.close(4009, 'flooded');
      return true;
    }
    return false;
  }

  async function handleMessage(ws: WebSocket, ctx: ConnectionContext, envelope: Envelope) {
    // General rate limiting
    if (!ctx.bucket.take()) {
      if (handleViolation(ws, ctx)) return;
      sendError(ws, 'rate-limited', 'Too many messages');
      return;
    }

    const { type, payload, v } = envelope;

    if (v !== PROTOCOL_VERSION) {
      sendError(
        ws,
        'version-mismatch',
        `Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${v}`,
      );
      return;
    }

    if (!(type in MessageSchemas)) {
      ctx.unknownTypeCount++;
      if (ctx.unknownTypeCount > 50) {
        ws.terminate();
        connections.delete(ws);
        return;
      }
      sendError(ws, 'unknown-type', `Unknown message type: ${type}`);
      return;
    }

    const result = parseMessage(type, payload);
    if (!result.success) {
      sendError(
        ws,
        'invalid-message',
        result.error === 'unknown-type' ? 'Unknown type' : 'Invalid payload',
      );
      return;
    }

    const data = result.data;

    // Handshake state machine
    switch (ctx.state) {
      case 'hello':
        if (type === 'hello') {
          ws.send(encodeMessage('version-ok', { v: PROTOCOL_VERSION }));
          ctx.state = 'auth';
        } else {
          sendError(ws, 'invalid-message', 'Expected hello message');
        }
        break;

      case 'auth':
        if (type === 'auth') {
          const authData = data as z.infer<typeof AuthSchema>;
          const token = authData.token;
          
          if (!token) {
            sendError(ws, 'unauthenticated', 'Missing session token');
            return;
          }

          const payload = verifyToken(token);
          if (!payload) {
            sendError(ws, 'unauthenticated', 'Invalid or expired session token');
            return;
          }

          const tokenHash = hashToken(token);
          const session = await repo.findSession(tokenHash);
          if (!session) {
            sendError(ws, 'unauthenticated', 'Session not found or revoked');
            return;
          }

          ctx.playerId = session.player_id;
          ctx.state = 'join_system';
          ws.send(encodeMessage('auth_ok', { playerId: session.player_id }));
        } else {
          sendError(ws, 'invalid-message', 'Expected auth message');
        }
        break;

      case 'join_system':
        if (type === 'join_system') {
          const joinData = data as z.infer<typeof JoinSystemSchema>;
          const { systemId } = joinData;
          ctx.systemId = systemId;

          // Mock snapshot
          const snapshot = {
            systemId,
            entities: [],
            nodes: [],
            chat: [],
            players: [{ id: ctx.playerId!, callsign: ctx.playerId!, systemId }],
          };

          ws.send(encodeMessage('enter_system', { snapshot }));
          ctx.state = 'active';
        } else {
          sendError(ws, 'invalid-message', 'Expected join_system message');
        }
        break;

      case 'active':
        if (type === 'pong') {
          ctx.lastPong = Date.now();
        } else if (type === 'input') {
          // Handle input... (to be implemented in later tasks)
        } else if (type === 'chat') {
          const chatData = data as { text: string };
          const chatCheck = ctx.chatLimiter.check(chatData.text);
          if (!chatCheck.allowed) {
            if (handleViolation(ws, ctx)) return;
            sendError(ws, 'rate-limited', chatCheck.reason || 'Chat limit exceeded');
            return;
          }
          ctx.chatLimiter.recordSend();
          // Handle chat broadcast...
        } else {
          // Handle other active messages...
        }
        break;
    }
  }
}

function sendError(ws: WebSocket, code: any, message: string) {
  ws.send(encodeMessage('error', { code, message }));
}
