import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from './app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from './ws';
import { encodeMessage, decodeEnvelope } from '../shared/protocol';
import { migrate, closeDb } from './db/client';

describe('Rate Limiting Integration', () => {
  let wss: WebSocketServer;
  let fastify: any;
  let port: number;
  let cleanup: () => void;

  beforeEach(async () => {
    process.env.DB_PATH = `/tmp/ratelimit_${Math.random().toString(36).substring(7)}.sqlite`;
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
    return JSON.parse(resp.payload as string).token;
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

  const completeHandshake = async (ws: WebSocket) => {
    const token = await getAuthToken(`RateLimit-${Math.random().toString(36).substring(7)}`);
    ws.send(encodeMessage('hello', { v: 1 }));
    await receiveMessageType(ws, 'version-ok');
    ws.send(encodeMessage('auth', { token }));
    await receiveMessageType(ws, 'auth_ok');
    ws.send(encodeMessage('join_system', { systemId: 'sol' }));
    await receiveMessageType(ws, 'enter_system');
  };

  it('should allow burst of 40 messages then rate limit', async () => {
    const ws = await createClient();
    await completeHandshake(ws);

    // Send 40 messages (burst)
    for (let i = 0; i < 40; i++) {
      ws.send(encodeMessage('pong', { ts: Date.now() }));
    }

    // 41st message should be rate-limited
    ws.send(encodeMessage('pong', { ts: Date.now() }));
    const resp = await receiveMessageType(ws, 'error');
    expect(resp.payload.code).toBe('rate-limited');

    ws.close();
  });

  it('should drop connection after 3 rate-limit violations within 10s', async () => {
    const ws = await createClient();
    await completeHandshake(ws);

    // Drain bucket
    for (let i = 0; i < 40; i++) {
      ws.send(encodeMessage('pong', { ts: Date.now() }));
    }

    // Violation 1
    ws.send(encodeMessage('pong', { ts: Date.now() }));
    await receiveMessageType(ws, 'error');
    // Violation 2
    ws.send(encodeMessage('pong', { ts: Date.now() }));
    await receiveMessageType(ws, 'error');
    // Violation 3 -> should close with 4009
    ws.send(encodeMessage('pong', { ts: Date.now() }));

    return new Promise((resolve) => {
      ws.on('close', (code) => {
        expect(code).toBe(4009);
        resolve(true);
      });
      setTimeout(() => resolve(false), 2000);
    }).then((closed) => expect(closed).toBe(true));
  });

  it('should enforce chat limits', async () => {
    const ws = await createClient();
    await completeHandshake(ws);

    // 1. First chat message: ok
    ws.send(encodeMessage('chat', { text: 'Hello world', channel: 'local' }));
    // We don't expect a response for chat from server currently, 
    // but we should wait for it to be processed if necessary.
    // In a real scenario we might wait for the broadcast.
    
    // Give a small delay for the server to process the first message
    await new Promise(resolve => setTimeout(resolve, 100));

    // 2. Immediate second message: rate-limited (gap < 2s)
    ws.send(encodeMessage('chat', { text: 'Spamming', channel: 'local' }));
    const resp = await receiveMessageType(ws, 'error');
    expect(resp.payload.code).toBe('rate-limited');
    expect(resp.payload.message).toContain('Sending too fast');

    // 3. Message too long: rate-limited
    ws.send(encodeMessage('chat', { text: 'a'.repeat(501), channel: 'local' }));
    const respLong = await receiveMessageType(ws, 'error');
    expect(respLong.payload.code).toBe('rate-limited');
    expect(respLong.payload.message).toContain('Message too long');

    ws.close();
  });

  it('should escalate chat violations to connection drop', async () => {
    const ws = await createClient();
    await completeHandshake(ws);

    // 3 chat violations
    ws.send(encodeMessage('chat', { text: '1', channel: 'local' })); // OK
    await new Promise(resolve => setTimeout(resolve, 100));

    ws.send(encodeMessage('chat', { text: '2', channel: 'local' })); // Violation 1 (gap)
    await receiveMessageType(ws, 'error');

    ws.send(encodeMessage('chat', { text: '3', channel: 'local' })); // Violation 2 (gap)
    await receiveMessageType(ws, 'error');

    ws.send(encodeMessage('chat', { text: '4', channel: 'local' })); // Violation 3 (gap)

    return new Promise((resolve) => {
      ws.on('close', (code) => {
        expect(code).toBe(4009);
        resolve(true);
      });
      setTimeout(() => resolve(false), 2000);
    }).then((closed) => expect(closed).toBe(true));
  });
});
