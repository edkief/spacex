import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/server/app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from '../src/server/ws';
import { encodeMessage, decodeEnvelope } from '../src/shared/protocol';
import { migrate } from '../src/server/db/client';
import fastify from 'fastify';

describe('Auth Integration (TASK-10)', () => {
  let wss: WebSocketServer;
  let server: any;
  let port: number;

  beforeEach(async () => {
    process.env.DB_PATH = '/tmp/test.sqlite';
    await migrate();
    server = createApp();
    await server.listen({ port: 0, host: '127.0.0.1' });
    port = (server.server as any).address().port;
    wss = new WebSocketServer({ server: server.server });
    setupWebSocketHandler(wss);
  });

  afterEach(async () => {
    wss.close();
    await server.close();
  });

  const createClient = () =>
    new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on('open', () => resolve(ws));
    });

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

  it('should claim a callsign and use the token for WS auth', async () => {
    const callsign = `Pilot-${Math.random().toString(36).substring(7)}`;
    
    // 1. Claim callsign via REST
    const claimResp = await server.inject({
      method: 'POST',
      url: '/api/callsigns',
      payload: { callsign },
    });
    
    expect(claimResp.statusCode).toBe(200);
    const claimData = JSON.parse(claimResp.payload as string);
    expect(claimData).toHaveProperty('token');
    expect(claimData).toHaveProperty('playerId');
    expect(claimData.callsign).toBe(callsign.toLowerCase());

    const token = claimData.token;

    // 2. Authenticate via WebSocket
    const ws = await createClient();
    
    // Hello
    ws.send(encodeMessage('hello', { v: 1 }));
    await receive(ws);

    // Auth with token
    ws.send(encodeMessage('auth', { token }));
    const authResp = await receive(ws);
    expect(authResp.type).toBe('auth_ok');

    // Join system
    ws.send(encodeMessage('join_system', { systemId: claimData.homeSystemId }));
    const joinResp = await receive(ws);
    
    expect(joinResp.type).toBe('enter_system');
    expect(joinResp.payload).toHaveProperty('snapshot');
    
    ws.close();
  });

  it('should reject duplicate callsign claims', async () => {
    const callsign = `Dup-${Math.random().toString(36).substring(7)}`;
    
    // First claim
    await server.inject({
      method: 'POST',
      url: '/api/callsigns',
      payload: { callsign },
    });

    // Second claim
    const claimResp = await server.inject({
      method: 'POST',
      url: '/api/callsigns',
      payload: { callsign },
    });
    
    expect(claimResp.statusCode).toBe(409);
    const errorData = JSON.parse(claimResp.payload as string);
    expect(errorData.code).toBe('callsign-taken');
  });

  it('should validate callsign format', async () => {
    const invalidCallsigns = ['ab', 'too-long-callsign-123456789', 'invalid@char'];
    
    for (const callsign of invalidCallsigns) {
      const resp = await server.inject({
        method: 'POST',
        url: '/api/callsigns',
        payload: { callsign },
      });
      expect(resp.statusCode).toBe(400);
    }
  });

  it('should verify session via GET /api/session', async () => {
    const callsign = `Sess-${Math.random().toString(36).substring(7)}`;
    const claimResp = await server.inject({
      method: 'POST',
      url: '/api/callsigns',
      payload: { callsign },
    });
    const { token } = JSON.parse(claimResp.payload as string);

    const sessionResp = await server.inject({
      method: 'GET',
      url: '/api/session',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    
    expect(sessionResp.statusCode).toBe(200);
    const sessionData = JSON.parse(sessionResp.payload as string);
    expect(sessionData.callsign).toBe(callsign.toLowerCase());
    expect(sessionData).toHaveProperty('credits');
  });

  it('should reject invalid session tokens', async () => {
    const sessionResp = await server.inject({
      method: 'GET',
      url: '/api/session',
      headers: {
        authorization: 'Bearer invalid-token',
      },
    });
    
    expect(sessionResp.statusCode).toBe(401);
    const errorData = JSON.parse(sessionResp.payload as string);
    expect(errorData.code).toBe('unauthenticated');
  });

  it('should reject WS auth with invalid token', async () => {
    const ws = await createClient();
    
    ws.send(encodeMessage('hello', { v: 1 }));
    await receive(ws);

    ws.send(encodeMessage('auth', { token: 'invalid-token' }));
    const resp = await receive(ws);
    
    expect(resp.type).toBe('error');
    expect((resp.payload as any).code).toBe('unauthenticated');
    
    ws.close();
  });
});
