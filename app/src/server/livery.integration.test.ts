import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from './app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from './ws';
import { encodeMessage, decodeEnvelope } from '../shared/protocol';
import { migrate, initDb } from './db/client';
import { repo } from './db/repo';
import { signToken, hashToken } from './auth/token';
import fs from 'fs';
import path from 'path';

describe('Livery Broadcast Integration', () => {
  let wss: WebSocketServer;
  let fastify: any;
  let port: number;

  beforeEach(async () => {
    const TEST_DB_PATH = path.join('/tmp/opencode', 'livery-test.sqlite');
    process.env.DB_DRIVER = 'sqlite';
    process.env.DB_PATH = TEST_DB_PATH;
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    initDb();
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

  const setupPlayer = async (callsign: string) => {
    const player = await repo.createPlayer(callsign, 'sol');
    const token = signToken({ playerId: player.id, systemId: 'sol', exp: Date.now() + 3600000 });
    const tokenHash = hashToken(token);
    await repo.createSession(player.id, 'sol', tokenHash);
    await repo.getOrCreateStarterShip(player.id, 'sol');
    return { player, token };
  };

  const authenticateAndJoin = async (ws: WebSocket, token: string) => {
    ws.send(encodeMessage('hello', { v: 1 }));
    await receive(ws);
    ws.send(encodeMessage('auth', { token }));
    await receive(ws);
    ws.send(encodeMessage('join_system', { systemId: 'sol' }));
    await receive(ws);
  };

  it('should broadcast livery changes to other clients in the same system', async () => {
    const p1 = await setupPlayer('Pilot1');
    const p2 = await setupPlayer('Pilot2');

    const ws1 = await createClient();
    const ws2 = await createClient();

    await authenticateAndJoin(ws1, p1.token);
    await authenticateAndJoin(ws2, p2.token);

    const newLivery = {
      hull: '#ff0000',
      accent: '#00ff00',
      trim: '#0000ff',
    };

    // Client 1 updates livery via REST API
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/ships/livery',
      headers: {
        authorization: `Bearer ${p1.token}`,
      },
      payload: newLivery,
    });

    expect(response.statusCode).toBe(200);

    // Client 2 should receive an entity_update
    const message = await receive(ws2);
    expect(message.type).toBe('entity_update');

    const updatedEntity = (message.payload as any).entities.find(
      (e: any) => e.callsign === 'Pilot1',
    );

    expect(updatedEntity).toBeDefined();
    expect(updatedEntity.livery).toBe(JSON.stringify(newLivery));

    ws1.close();
    ws2.close();
  });
});
