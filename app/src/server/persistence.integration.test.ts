import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs';
import { encodeMessage, decodeEnvelope } from '../shared/protocol';
import { signToken, hashToken } from './auth/token';
import { repo } from './db/repo';
import { initDb, migrate } from './db/client';

describe('Ship State Persistence Crash Test', () => {
  const TEST_DB_PATH = path.join('/tmp/opencode', 'persistence-crash-test.sqlite');
  const PORT = 8081;

  beforeEach(async () => {
    process.env.DB_DRIVER = 'sqlite';
    process.env.DB_PATH = TEST_DB_PATH;
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    initDb();
    await migrate();
  });

  const startServer = (): Promise<{ process: any; port: number }> => {
    return new Promise((resolve) => {
      const child = spawn('npx', ['tsx', 'src/server/index.ts'], {
        cwd: path.join(process.cwd(), 'app'),
        env: {
          ...process.env,
          PORT: PORT.toString(),
          DB_PATH: TEST_DB_PATH,
          DB_DRIVER: 'sqlite',
          PERSIST_INTERVAL_MS: '5000',
        },
      });

      child.stdout.on('data', (data: any) => console.log(`[SERVER]: ${data}`));
      child.stderr.on('data', (data: any) => console.error(`[SERVER ERR]: ${data}`));

      // Wait for server to be ready (simple poll or check output)
      const checkInterval = setInterval(async () => {
        try {
          const res = await fetch(`http://localhost:${PORT}/api/health`);
          if (res.ok) {
            clearInterval(checkInterval);
            resolve({ process: child, port: PORT });
          }
        } catch (e) {
          // not ready yet
        }
      }, 500);
    });
  };

  const createClient = (port: number) =>
    new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
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

  const authenticateAndJoin = async (ws: WebSocket, token: string) => {
    ws.send(encodeMessage('hello', { v: 1 }));
    await receive(ws);
    ws.send(encodeMessage('auth', { token }));
    await receive(ws);
    ws.send(encodeMessage('join_system', { systemId: 'sol' }));
    await receive(ws);
  };

  it('should persist ship position across SIGKILL restart', async () => {
    const callsign = 'CrashTestPilot';
    const player = await repo.createPlayer(callsign, 'sol');
    const token = signToken({ playerId: player.id, systemId: 'sol', exp: Date.now() + 3600000 });
    const tokenHash = hashToken(token);
    await repo.createSession(player.id, 'sol', tokenHash);
    const ship = await repo.getOrCreateStarterShip(player.id, 'sol');

    // 1. Start server 1
    const s1 = await startServer();
    const ws1 = await createClient(s1.port);
    await authenticateAndJoin(ws1, token);

    // 2. Move ship (send inputs)
    // thrust: 1, pitch: 0, yaw: 0, roll: 0
    for (let i = 0; i < 40; i++) {
      ws1.send(encodeMessage('input', { seq: i + 1, thrust: 1, pitch: 0, yaw: 0, turn: 0 }));
      await new Promise((r) => setTimeout(r, 50));
    }

    // Wait for the 5s flush to occur
    await new Promise((r) => setTimeout(r, 6000));

    // Wait for a snapshot to confirm position
    let finalPos = { x: 0, y: 0, z: 0 };
    const snapshot = await receive(ws1);
    if (snapshot.type === 'entity_update') {
      const shipEntity = (snapshot.payload as any).entities.find((e: any) => e.id === ship.id);
      if (shipEntity) finalPos = shipEntity.pos;
    }

    // 3. Kill the process (SIGKILL)
    s1.process.kill('SIGKILL');
    ws1.close();

    // 4. Restart server 2
    const s2 = await startServer();
    const ws2 = await createClient(s2.port);
    await authenticateAndJoin(ws2, token);

    // 5. Check position continuity
    let response2;
    while (true) {
      response2 = await receive(ws2);
      if (response2.type === 'enter_system' || response2.type === 'entity_update') {
        break;
      }
    }

    console.log(`Received response: ${response2.type}`);
    let entities;
    if (response2.type === 'enter_system') {
      entities = response2.payload.snapshot.entities;
    } else if (response2.type === 'entity_update') {
      entities = response2.payload.entities;
    }

    expect(entities).toBeDefined();
    const shipEntity2 = entities.find((e: any) => e.id === ship.id);

    expect(shipEntity2).toBeDefined();

    const pos2 = shipEntity2.pos;
    const dist = Math.sqrt(
      Math.pow(pos2.x - finalPos.x, 2) +
        Math.pow(pos2.y - finalPos.y, 2) +
        Math.pow(pos2.z - finalPos.z, 2),
    );

    expect(dist).toBeLessThan(1.0);

    s2.process.kill();
  }, 300000);
});
