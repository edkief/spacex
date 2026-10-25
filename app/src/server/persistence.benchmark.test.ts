import { describe, it, expect, beforeEach } from 'vitest';
import { persistService } from './persist';
import { repo } from './db/repo';
import { initDb, migrate } from './db/client';
import path from 'path';
import fs from 'fs';

describe('Persistence Performance', () => {
  const TEST_DB_PATH = path.join('/tmp/opencode', 'persistence-bench.sqlite');

  beforeEach(async () => {
    process.env.DB_DRIVER = 'sqlite';
    process.env.DB_PATH = TEST_DB_PATH;
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    initDb();
    await migrate();
  });

  it('should flush 16 ships in under 8ms p95', async () => {
    const systemId = 'sol';
    const ships = new Map<string, any>();
    
    // Setup 16 ships in DB and simulation
    for (let i = 0; i < 16; i++) {
      const player = await repo.createPlayer(`player-${i}`, systemId);
      const ship = await repo.getOrCreateStarterShip(player.id, systemId);
      
      ships.set(ship.id, {
        id: ship.id,
        pos: { x: Math.random(), y: Math.random(), z: Math.random() },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: ship.regime,
        hull: ship.hull,
        shields: ship.shields,
        destroyed: false,
        onPad: false,
        wreckExpiresAt: null,
      });
    }

    const latencies: number[] = [];
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await persistService.flushShips(systemId, ships);
      const end = performance.now();
      latencies.push(end - start);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(iterations * 0.5)];
    const p95 = latencies[Math.floor(iterations * 0.95)];
    const p99 = latencies[Math.floor(iterations * 0.99)];

    console.log(`Flush Latency (16 ships): p50=${p50.toFixed(3)}ms, p95=${p95.toFixed(3)}ms, p99=${p99.toFixed(3)}ms`);
    
    expect(p95).toBeLessThan(8);
  });
});
