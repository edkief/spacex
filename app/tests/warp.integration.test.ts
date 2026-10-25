import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/server/app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from '../src/server/ws';
import { encodeMessage, decodeEnvelope } from '../src/shared/protocol';
import { migrate } from '../src/server/db/client';
import { router } from '../src/server/galaxy';
import fastify from 'fastify';
import fs from 'node:fs';

describe('Warp Integration (TASK-8)', () => {
  let wss: WebSocketServer;
  let server: any;
  let port: number;

  beforeEach(async () => {
    process.env.DB_PATH = '/tmp/warp_test.sqlite';
    if (fs.existsSync(process.env.DB_PATH)) {
      fs.unlinkSync(process.env.DB_PATH);
    }
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

  async function setupAuthenticatedClient(callsign: string, systemId: string) {
    const claimResp = await server.inject({
      method: 'POST',
      url: '/api/callsigns',
      payload: { callsign },
    });
    const payload = typeof claimResp.payload === 'string' 
      ? JSON.parse(claimResp.payload) 
      : claimResp.payload;
    console.log(`[Test] Claim payload: ${JSON.stringify(payload)}`);
    const { token, playerId } = payload;
    
    const ws = await createClient();
    ws.send(encodeMessage('hello', { v: 1 }));
    await receive(ws);
    ws.send(encodeMessage('auth', { token }));
    await receive(ws);
    ws.send(encodeMessage('join_system', { systemId }));
    await receive(ws);
    
    return { ws, playerId };
  }

  it('should warp a player between two systems', async () => {
    const systemA = 'sol';
    const systemB = 'alpha-centauri';
    
    const { ws, playerId } = await setupAuthenticatedClient('WarpPilot', systemA);
    
    // 1. Initiate warp
    ws.send(encodeMessage('warp', { destinationSystemId: systemB }));
    
    const resp = await receive(ws);
    expect(resp.type).toBe('warp-arrived');
    expect(resp.payload.systemId).toBe(systemB);
    expect(resp.payload.snapshot).toBeDefined();
    
    // Verify position is at spawn gate (100, 0, 0)
    const shipId = resp.payload.shipId;
    const ship = resp.payload.snapshot.find((e: any) => e.id === shipId);
    if (!ship) {
        throw new Error(`Ship ${shipId} not found in warp-arrived snapshot`);
    }
    expect(ship.pos).toEqual({ x: 100, y: 0, z: 0 });
    
    ws.close();
  });

  it('should reject warp to the same system', async () => {
    const systemA = 'sol';
    const { ws } = await setupAuthenticatedClient('StayPilot', systemA);
    
    ws.send(encodeMessage('warp', { destinationSystemId: systemA }));
    const resp = await receive(ws);
    
    expect(resp.type).toBe('error');
    expect(resp.payload.code).toBe('invalid-warp');
    
    ws.close();
  });

  it('should reject warp to a full system', async () => {
    const systemA = 'sol';
    const systemB = 'crowded-system';
    
    // Fill system B
    const shardB = await router.getShard(systemB);
    for (let i = 0; i < 16; i++) {
      shardB.addConnection(`dummy-${i}`, {
        callsign: `Dummy-${i}`,
        lastSeq: 0,
        inputQueue: [],
      });
    }
    
    const { ws } = await setupAuthenticatedClient('LatePilot', systemA);
    
    ws.send(encodeMessage('warp', { destinationSystemId: systemB }));
    const resp = await receive(ws);
    
    expect(resp.type).toBe('error');
    expect(resp.payload.code).toBe('system-full');
    
    ws.close();
  });
});
