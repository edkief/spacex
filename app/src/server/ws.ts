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

type ConnectionState = 'hello' | 'auth' | 'join_system' | 'active';

interface ConnectionContext {
  state: ConnectionState;
  playerId?: string;
  systemId?: string;
  unknownTypeCount: number;
  lastPong: number;
}

export function setupWebSocketHandler(wss: WebSocketServer) {
  const connections = new Map<WebSocket, ConnectionContext>();
  const MAX_MESSAGE_SIZE = 64 * 1024;

  wss.on('connection', (ws) => {
    const ctx: ConnectionContext = {
      state: 'hello',
      unknownTypeCount: 0,
      lastPong: Date.now(),
    };
    connections.set(ws, ctx);

    ws.on('message', (data) => {
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
      handleMessage(ws, ctx, result.data);
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

  function handleMessage(ws: WebSocket, ctx: ConnectionContext, envelope: Envelope) {
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
          // Mock auth: any callsign or token works for now
          const authData = data as z.infer<typeof AuthSchema>;
          ctx.playerId = authData.callsign || 'unknown-pilot';
          ctx.state = 'join_system';
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
          // Handle chat...
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
