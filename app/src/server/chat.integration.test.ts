import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from './app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from './ws';
import { encodeMessage, decodeEnvelope } from '../shared/protocol';
import { migrate, closeDb } from './db/client';

describe('Chat Integration', () => {
  let wss: WebSocketServer;
  let fastify: any;
  let port: number;
  let cleanup: () => void;

  beforeEach(async () => {
    process.env.DB_PATH = `/tmp/chat_${Math.random().toString(36).substring(7)}.sqlite`;
    await migrate();
    fastify = createApp();
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    port = (fastify.server as any).address().port;
    wss = new WebSocketServer({ server: fastify.server });
    cleanup = setupWebSocketHandler(wss);
  });

  afterEach(async () => {
    if (cleanup) cleanup();
    wss.close();
    await fastify.close();
    await closeDb();
  });

  const createClient = () =>
    new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on('open', () => resolve(ws));
    });

  const getAuthToken = async (callsign: string) => {
    const resp = await fastify.inject({
      method: 'POST',
      url: '/api/callsigns',
      payload: { callsign },
    });
    const payload = JSON.parse(resp.payload as string);
    if (!payload.token) {
      console.error(`Failed to get token for ${callsign}:`, payload);
    }
    return payload.token;
  };

  const receiveMessageType = (ws: WebSocket, type: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const handler = (data: any) => {
        const result = decodeEnvelope(data.toString());
        if (result.success) {
          if (result.data.type === type) {
            ws.off('message', handler);
            resolve(result.data);
          } else if (result.data.type === 'error') {
            ws.off('message', handler);
            reject(new Error(`Server error while waiting for ${type}: ${JSON.stringify(result.data.payload)}`));
          }
        }
      };
      ws.on('message', handler);
      
      // Add a timeout to avoid hanging forever
      setTimeout(() => {
        ws.off('message', handler);
        reject(new Error(`Timeout waiting for message type: ${type}`));
      }, 15000);

      ws.once('close', () => {
        ws.off('message', handler);
        reject(new Error('Connection closed'));
      });
      ws.once('error', (err) => {
        ws.off('message', handler);
        reject(err);
      });
    });

  const completeHandshake = async (ws: WebSocket, callsign: string) => {
    const token = await getAuthToken(callsign);
    ws.send(encodeMessage('hello', { v: 1 }));
    await receiveMessageType(ws, 'version-ok');
    ws.send(encodeMessage('auth', { token }));
    await receiveMessageType(ws, 'auth_ok');
    ws.send(encodeMessage('join_system', { systemId: 'sol' }));
    await receiveMessageType(ws, 'enter_system');
  };

  it('should broadcast chat messages to all players in a shard', async () => {
    const ws1 = await createClient();
    await completeHandshake(ws1, 'Alice1');
    const ws2 = await createClient();
    await completeHandshake(ws2, 'Bob1');

    // Alice sends a message
    ws1.send(encodeMessage('chat', { text: 'Hello Bob!' }));

    const msg1 = await receiveMessageType(ws1, 'chat');
    const msg2 = await receiveMessageType(ws2, 'chat');

    expect(msg1.payload.from).toBe('alice1');
    expect(msg1.payload.text).toBe('Hello Bob!');
    expect(msg2.payload.from).toBe('alice1');
    expect(msg2.payload.text).toBe('Hello Bob!');
    expect(msg1.payload.ts).toBe(msg2.payload.ts);
  });

  it('should sanitize chat messages by stripping control characters', async () => {
    const ws1 = await createClient();
    await completeHandshake(ws1, 'Alice2');

    const xssPayload = '<img src=x onerror=alert(1)>\x00\x1F';
    ws1.send(encodeMessage('chat', { text: xssPayload }));

    const msg = await receiveMessageType(ws1, 'chat');
    expect(msg.payload.text).not.toContain('\x00');
    expect(msg.payload.text).not.toContain('\x1F');
    expect(msg.payload.text).toBe('<img src=x onerror=alert(1)>');
  });

  it('should reject empty or overly long messages', async () => {
    const ws1 = await createClient();
    await completeHandshake(ws1, 'Alice3');

    // Empty message
    ws1.send(encodeMessage('chat', { text: '   ' }));
    const err1 = await receiveMessageType(ws1, 'error');
    expect(err1.payload.code).toBe('invalid-message');

    // Too long message
    ws1.send(encodeMessage('chat', { text: 'a'.repeat(201) }));
    const err2 = await receiveMessageType(ws1, 'error');
    expect(err2.payload.code).toBe('invalid-message');
  });

  it('should enforce rate limits (> 5 messages / 10 s)', async () => {
    const ws1 = await createClient();
    await completeHandshake(ws1, 'Alice4');

    // Send 5 messages quickly
    for (let i = 0; i < 5; i++) {
      ws1.send(encodeMessage('chat', { text: `Msg ${i}` }));
      // We need to consume these messages or they will interfere with the next one
      await receiveMessageType(ws1, 'chat');
    }

    // 6th message should be rate-limited
    ws1.send(encodeMessage('chat', { text: 'Msg 6' }));

    const err = await receiveMessageType(ws1, 'error');
    expect(err.payload.code).toBe('rate-limited');
  });
});
