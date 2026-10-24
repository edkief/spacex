import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Shard } from './shard';

describe('Shard', () => {
  let shard: Shard;
  const systemId = 'sys-1';

  beforeEach(() => {
    shard = new Shard(systemId);
    vi.useFakeTimers();
  });

  it('should integrate ship movements based on inputs', () => {
    const playerId = 'player-1';
    const shipId = 'ship-1';
    const connId = 'conn-1';

    shard.connections.set(connId, {
      playerId,
      lastSeq: 0,
      inputQueue: [],
    });
    shard.playerShips.set(playerId, shipId);
    shard.entities.set(shipId, {
      id: shipId,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      hull: 100,
      shields: 100,
      targetId: null,
    });

    // Send input: thrust forward (z+)
    shard.handleInput(connId, {
      seq: 1,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
    });

    shard.start();
    
    // Advance by one tick (50ms)
    vi.advanceTimersByTime(50);
    
    const entity = shard.entities.get(shipId)!;
    expect(entity.pos.z).toBeGreaterThan(0);
    
    shard.stop();
  });

  it('should ignore stale input sequences', () => {
    const playerId = 'player-1';
    const shipId = 'ship-1';
    const connId = 'conn-1';

    shard.connections.set(connId, {
      playerId,
      lastSeq: 10,
      inputQueue: [],
    });
    shard.playerShips.set(playerId, shipId);
    shard.entities.set(shipId, {
      id: shipId,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      hull: 100,
      shields: 100,
      targetId: null,
    });

    // Send stale input
    shard.handleInput(connId, {
      seq: 5,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
    });

    expect(shard.connections.get(connId)!.inputQueue.length).toBe(0);
  });

  it('should only take the latest input per tick', () => {
    const playerId = 'player-1';
    const shipId = 'ship-1';
    const connId = 'conn-1';

    shard.connections.set(connId, {
      playerId,
      lastSeq: 0,
      inputQueue: [],
    });
    shard.playerShips.set(playerId, shipId);
    shard.entities.set(shipId, {
      id: shipId,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      hull: 100,
      shields: 100,
      targetId: null,
    });

    // Send multiple inputs
    shard.handleInput(connId, { seq: 1, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false });
    shard.handleInput(connId, { seq: 2, thrust: 1, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false });

    shard.start();
    vi.advanceTimersByTime(50);
    
    // After one tick, inputQueue should be empty
    expect(shard.connections.get(connId)!.inputQueue.length).toBe(0);
    
    const entity = shard.entities.get(shipId)!;
    expect(entity.pos.z).toBeGreaterThan(0);
    
    shard.stop();
  });

  it('should broadcast snapshots every 2nd tick (10 Hz)', () => {
    const sendSpy = vi.fn();
    shard.on('send', sendSpy);

    // Add a connection to ensure broadcast has a target
    shard.connections.set('conn-1', {
      playerId: 'player-1',
      lastSeq: 0,
      inputQueue: [],
    });

    shard.start();
    
    // Tick 1: no snapshot
    vi.advanceTimersByTime(50);
    expect(sendSpy).not.toHaveBeenCalled();
    
    // Tick 2: snapshot
    vi.advanceTimersByTime(50);
    expect(sendSpy).toHaveBeenCalled();
    
    shard.stop();
  });

  it('should meet performance budget (p95 < 30ms) with 16 ships', async () => {
    const numShips = 16;
    const durationSec = 2; // Reduced for test speed
    const tickRate = 20;
    const totalTicks = durationSec * tickRate;

    for (let i = 0; i < numShips; i++) {
      const pId = `p${i}`;
      const sId = `s${i}`;
      const cId = `c${i}`;
      
      shard.connections.set(cId, { playerId: pId, lastSeq: 0, inputQueue: [] });
      shard.playerShips.set(pId, sId);
      shard.entities.set(sId, {
        id: sId,
        pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: 'space',
        hull: 100,
        shields: 100,
        targetId: null,
      });
    }

    // Use real timers for benchmark
    vi.useRealTimers();
    
    shard.start();

    // Simulate inputs for each ship every tick
    const inputInterval = setInterval(() => {
      for (const [connId, conn] of shard.connections) {
        shard.handleInput(connId, {
          seq: ++conn.lastSeq,
          thrust: Math.random(),
          turn: Math.random(),
          pitch: Math.random(),
          yaw: Math.random(),
          fire: false,
          lock: false,
        });
      }
    }, 50);

    // Wait for 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    clearInterval(inputInterval);
    shard.stop();
    
    const stats = shard.getTimingStats();
    expect(stats).not.toBeNull();
    console.log(`Benchmark results (16 ships): p50=${stats!.p50.toFixed(3)}ms, p95=${stats!.p95.toFixed(3)}ms, p99=${stats!.p99.toFixed(3)}ms`);
    expect(stats!.p95).toBeLessThan(30);
  });
});
