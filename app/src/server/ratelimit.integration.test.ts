import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from './app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from './ws';
import { encodeMessage, decodeEnvelope } from '../shared/protocol';
import { migrate } from './db/client';

describe('Rate Limiting Integration', () => {
  let wss: WebSocketServer;
  let fastify: any;
  let port: number;

  beforeEach(async () => {
    process.env.DB_PATH = '/tmp/ratelimit.sqlite';
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

  const completeHandshake = async (ws: WebSocket) => {
    const token = await getAuthToken(`RateLimit-${Math.random().toString(36).substring(7)}`);
    ws.send(encodeMessage('hello', { v: 1 }));
    await receive(ws);
    ws.send(encodeMessage('auth', { token }));
    await receive(ws);
    ws.send(encodeMessage('join_system', { systemId: 'sol' }));
    await receive(ws);
  };

  it('should allow burst of 40 messages then rate limit', async () => {
    const ws = await createClient();
    await completeHandshake(ws);

    // Send 40 messages (burst)
    for (let i = 0; i < 40; i++) {
      ws.send(encodeMessage('pong', { ts: Date.now() }));
      // We don't expect a response for pong in current handleMessage,
      // but the server should not send an error.
    }

    // 41st message should be rate-limited
    ws.send(encodeMessage('pong', { ts: Date.now() }));
    const resp = await receive(ws);
    expect(resp.type).toBe('error');
    expect((resp.payload as any).code).toBe('rate-limited');

    ws.close();
  });

  it('should drop connection after 3 rate-limit violations within 10s', async () => {
    const ws = await createClient();
    await completeHandshake(ws);

    // Drain bucket
    for (let i = 0; i < 40; i++) {
      ws.send(encodeMessage('pong', { ts: Date.now() }));
    }

    // We expect 2 rate-limited responses and then a close
    const responses: any[] = [];
    ws.on('message', (data) => {
      const result = decodeEnvelope(data.toString());
      if (result.success) responses.push(result.data);
    });

    // Violation 1
    ws.send(encodeMessage('pong', { ts: Date.now() }));
    // Violation 2
    ws.send(encodeMessage('pong', { ts: Date.now() }));
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
    // Current mock server doesn't respond to chat, so we just check that it doesn't error
    // But we can check for the next one.

    // 2. Immediate second message: rate-limited (gap < 2s)
    ws.send(encodeMessage('chat', { text: 'Spamming', channel: 'local' }));
    const resp = await receive(ws);
    expect(resp.type).toBe('error');
    expect((resp.payload as any).code).toBe('rate-limited');
    expect((resp.payload as any).message).toContain('Sending too fast');

    // 3. Message too long: rate-limited
    ws.send(encodeMessage('chat', { text: 'a'.repeat(501), channel: 'local' }));
    const respLong = await receive(ws);
    expect(respLong.type).toBe('error');
    expect((respLong.payload as any).code).toBe('rate-limited');
    expect((respLong.payload as any).message).toContain('Message too long');

    ws.close();
  });

  it('should escalate chat violations to connection drop', async () => {
    const ws = await createClient();
    await completeHandshake(ws);

    // 3 chat violations
    ws.send(encodeMessage('chat', { text: '1', channel: 'local' })); // OK

    ws.send(encodeMessage('chat', { text: '2', channel: 'local' })); // Violation 1 (gap)
    await receive(ws);

    ws.send(encodeMessage('chat', { text: '3', channel: 'local' })); // Violation 2 (gap)
    await receive(ws);

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
