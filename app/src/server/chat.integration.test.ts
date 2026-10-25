import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from './app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from './ws';
import { encodeMessage, decodeEnvelope } from '../shared/protocol';
import { migrate } from './db/client';

describe('Chat Integration', () => {
  let wss: WebSocketServer;
  let fastify: any;
  let port: number;

  beforeEach(async () => {
    process.env.DB_PATH = '/tmp/chat.sqlite';
    await migrate();
    fastify = createApp();
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    port = (fastify.server as any).address().port;
    wss = new WebSocketServer({ server: fastify.server });
    setupWebSocketHandler(wss);
  });

  afterEach(async () => {
    wss.close();
    await fastify.close();
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
    return JSON.parse(resp.payload as string).token;
  };

  const receive = (ws: WebSocket): Promise<any> =>
    new Promise((resolve, reject) => {
      ws.once('message', (data) => {
        const result = decodeEnvelope(data.toString());
        if (result.success) {
          resolve(result.data);
        } else {
          reject(new Error(`Decode error: ${result.error}`));
        }
      });
      ws.once('close', () => reject(new Error('Connection closed')));
      ws.once('error', (err) => reject(err));
    });

  const completeHandshake = async (ws: WebSocket, callsign: string) => {
    const token = await getAuthToken(callsign);
    ws.send(encodeMessage('hello', { v: 1 }));
    await receive(ws);
    ws.send(encodeMessage('auth', { token }));
    await receive(ws);
    ws.send(encodeMessage('join_system', { systemId: 'sol' }));
    await receive(ws);
  };

  it('should broadcast chat messages to all players in a shard', async () => {
    const ws1 = await createClient();
    await completeHandshake(ws1, 'Alice');
    const ws2 = await createClient();
    await completeHandshake(ws2, 'Bob');

    const receiveChat = (ws: WebSocket): Promise<any> =>
      new Promise((resolve) => {
        ws.on('message', (data) => {
          const result = decodeEnvelope(data.toString());
          if (result.success && result.data.type === 'chat') {
            resolve(result.data.payload);
          }
        });
      });

    // Alice sends a message
    ws1.send(encodeMessage('chat', { text: 'Hello Bob!' }));

    const msg1 = await receiveChat(ws1);
    const msg2 = await receiveChat(ws2);

    expect(msg1.from).toBe('Alice');
    expect(msg1.text).toBe('Hello Bob!');
    expect(msg2.from).toBe('Alice');
    expect(msg2.text).toBe('Hello Bob!');
    expect(msg1.ts).toBe(msg2.ts);
  });

  it('should sanitize chat messages by stripping control characters', async () => {
    const ws1 = await createClient();
    await completeHandshake(ws1, 'Alice');

    const xssPayload = '<img src=x onerror=alert(1)>\x00\x1F';
    ws1.send(encodeMessage('chat', { text: xssPayload }));

    const receiveChat = (ws: WebSocket): Promise<any> =>
      new Promise((resolve) => {
        ws.on('message', (data) => {
          const result = decodeEnvelope(data.toString());
          if (result.success && result.data.type === 'chat') {
            resolve(result.data.payload);
          }
        });
      });

    const msg = await receiveChat(ws1);
    expect(msg.text).not.toContain('\x00');
    expect(msg.text).not.toContain('\x1F');
    expect(msg.text).toBe('<img src=x onerror=alert(1)>');
  });

  it('should reject empty or overly long messages', async () => {
    const ws1 = await createClient();
    await completeHandshake(ws1, 'Alice');

    const receiveError = (ws: WebSocket): Promise<any> =>
      new Promise((resolve) => {
        ws.on('message', (data) => {
          const result = decodeEnvelope(data.toString());
          if (result.success && result.data.type === 'error') {
            resolve(result.data.payload);
          }
        });
      });

    // Empty message
    ws1.send(encodeMessage('chat', { text: '   ' }));
    const err1 = await receiveError(ws1);
    expect(err1.code).toBe('invalid-message');

    // Too long message
    ws1.send(encodeMessage('chat', { text: 'a'.repeat(201) }));
    const err2 = await receiveError(ws1);
    expect(err2.code).toBe('invalid-message');
  });

  it('should enforce rate limits (> 5 messages / 10 s)', async () => {
    const ws1 = await createClient();
    await completeHandshake(ws1, 'Alice');

    // Send 5 messages quickly
    for (let i = 0; i < 5; i++) {
      ws1.send(encodeMessage('chat', { text: `Msg ${i}` }));
    }

    // 6th message should be rate-limited
    ws1.send(encodeMessage('chat', { text: 'Msg 6' }));

    const receiveError = (ws: WebSocket): Promise<any> =>
      new Promise((resolve) => {
        ws.on('message', (data) => {
          const result = decodeEnvelope(data.toString());
          if (result.success && result.data.type === 'error') {
            resolve(result.data.payload);
          }
        });
      });

    const err = await receiveError(ws1);
    expect(err.code).toBe('rate-limited');
  });
});
