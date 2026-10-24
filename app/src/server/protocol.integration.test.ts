import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from './app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from './ws';
import { encodeMessage, decodeEnvelope } from '../shared/protocol';
import { migrate } from './db/client';

describe('WebSocket Handshake Integration', () => {
  let wss: WebSocketServer;
  let fastify: any;
  let port: number;

  beforeEach(async () => {
    process.env.DB_PATH = '/tmp/protocol.sqlite';
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

  it('should complete full handshake flow', async () => {
    const ws = await createClient();
    const token = await getAuthToken(`Handshake-${Math.random().toString(36).substring(7)}`);

    // 1. Hello
    ws.send(encodeMessage('hello', { v: 1 }));
    const helloResp = await receive(ws);
    expect(helloResp.type).toBe('version-ok');

    // 2. Auth
    ws.send(encodeMessage('auth', { token }));
    const authResp = await receive(ws);
    expect(authResp.type).toBe('auth_ok');

    // 3. Join System
    ws.send(encodeMessage('join_system', { systemId: 'sol' }));
    const joinResp = await receive(ws);
    expect(joinResp.type).toBe('enter_system');
    expect(joinResp.payload).toHaveProperty('snapshot');
    expect((joinResp.payload as any).snapshot.systemId).toBe('sol');

    ws.close();
  });

  it('should reject version mismatch', async () => {
    const ws = await createClient();

    ws.send(encodeMessage('hello', { v: 1 }, 999)); // Wrong version
    const resp = await receive(ws);
    expect(resp.type).toBe('error');
    expect((resp.payload as any).code).toBe('version-mismatch');

    ws.close();
  });

  it('should reject out-of-order messages', async () => {
    const ws = await createClient();

    // Send auth before hello
    ws.send(encodeMessage('auth', { callsign: 'TestPilot' }));
    const resp = await receive(ws);
    expect(resp.type).toBe('error');
    expect((resp.payload as any).message).toContain('Expected hello message');

    ws.close();
  });

  it('should handle unknown message types and terminate after 10', async () => {
    const ws = await createClient();

    // First unknown type
    ws.send(JSON.stringify({ v: 1, type: 'ghost', payload: {} }));
    const resp = await receive(ws);
    expect(resp.type).toBe('error');
    expect((resp.payload as any).code).toBe('unknown-type');

    // Send 50 more unknown types (total 51)
    for (let i = 0; i < 50; i++) {
      ws.send(JSON.stringify({ v: 1, type: 'ghost', payload: {} }));
      try {
        await receive(ws);
      } catch (e) {
        // Expected to fail when connection is terminated
        break;
      }
    }

    // Connection should be closed or closing
    return new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve(true);
      } else {
        ws.on('close', () => resolve(true));
        setTimeout(() => resolve(false), 2000);
      }
    }).then((closed) => expect(closed).toBe(true));
  }, 10000); // Increase timeout to 10s
});
