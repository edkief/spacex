import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Shard } from './shard';
import { persistService } from '../persist';
import { generateSystem } from '../../shared/galaxy/system';
import { padsFor } from '../../shared/world/pads';

vi.mock('../../shared/galaxy/system', () => ({
  generateSystem: vi.fn(),
}));

vi.mock('../../shared/world/pads', () => ({
  padsFor: vi.fn(),
}));

describe('Shard', () => {
  let shard: Shard;
  const systemId = '1234567890abcdef';
  const seed = 'dev-seed';

  beforeEach(() => {
    (generateSystem as any).mockReturnValue({
      systemId: 'sys-1',
      name: 'Test System',
      star: { class: 'G', name: 'Test Star' },
      planets: [],
    });
    (padsFor as any).mockReturnValue([
      { id: 'pad-1', pos: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, radius: 20 },
    ]);
    shard = new Shard(systemId, seed);
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
      kind: 'ship',
      classId: 'scout',
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      hull: 100,
      shields: 100,
      targetId: null,
    });

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
      kind: 'ship',
      classId: 'scout',
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      hull: 100,
      shields: 100,
      targetId: null,
    });

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
      kind: 'ship',
      classId: 'scout',
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      hull: 100,
      shields: 100,
      targetId: null,
    });

    shard.handleInput(connId, {
      seq: 1,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
    });
    shard.handleInput(connId, {
      seq: 2,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
    });

    shard.start();
    vi.advanceTimersByTime(50);

    expect(shard.connections.get(connId)!.inputQueue.length).toBe(0);

    const entity = shard.entities.get(shipId)!;
    expect(entity.pos.z).toBeGreaterThan(0);

    shard.stop();
  });

  it('should broadcast snapshots every 2nd tick (10 Hz)', () => {
    const sendSpy = vi.fn();
    shard.on('send', sendSpy);

    shard.connections.set('conn-1', {
      playerId: 'player-1',
      lastSeq: 0,
      inputQueue: [],
    });

    shard.start();
    vi.advanceTimersByTime(50);
    expect(sendSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(sendSpy).toHaveBeenCalled();

    shard.stop();
  });

  it('should meet performance budget (p95 < 30ms) with 16 ships', async () => {
    const numShips = 16;
    const durationSec = 2;
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
        kind: 'ship',
        classId: 'scout',
        pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: 'space',
        hull: 100,
        shields: 100,
        targetId: null,
      });
    }

    vi.useRealTimers();
    shard.start();

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

    await new Promise((resolve) => setTimeout(resolve, 2000));

    clearInterval(inputInterval);
    shard.stop();

    const stats = shard.getTimingStats();
    expect(stats).not.toBeNull();
    expect(stats!.p95).toBeLessThan(30);
  });

  it('should handle mid-flight disconnect and seamless reconnect', () => {
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
      kind: 'ship',
      classId: 'scout',
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      hull: 100,
      shields: 100,
      targetId: null,
    });

    shard.start();
    shard.handleInput(connId, { seq: 1, thrust: 1, turn: 0, pitch: 0, yaw: 0 });
    vi.advanceTimersByTime(100);
    const posBeforeDrop = { ...shard.entities.get(shipId)!.pos };

    shard.removeConnection(connId);
    vi.advanceTimersByTime(2000);
    const posAfterDrop = { ...shard.entities.get(shipId)!.pos };

    expect(posAfterDrop.z).toBeGreaterThan(posBeforeDrop.z);

    shard.addConnection(connId, {
      playerId,
      lastSeq: 1,
      inputQueue: [],
      callsign: 'Pilot',
    });

    shard.handleInput(connId, { seq: 2, thrust: 1, turn: 0, pitch: 0, yaw: 0 });
    vi.advanceTimersByTime(100);

    const posAfterReconnect = shard.entities.get(shipId)!.pos;
    expect(posAfterReconnect.z).toBeGreaterThan(posAfterDrop.z);

    shard.stop();
  });

  it('should not create duplicate entities on reconnect', () => {
    const playerId = 'player-1';
    const shipId = 'ship-1';
    const connId = 'conn-1';

    shard.playerShips.set(playerId, shipId);
    shard.entities.set(shipId, {
      id: shipId,
      kind: 'ship',
      classId: 'scout',
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
      hull: 100,
      shields: 100,
      targetId: null,
    });

    for (let i = 0; i < 3; i++) {
      shard.addConnection(connId, { playerId, lastSeq: 0, inputQueue: [], callsign: 'Pilot' });
      shard.removeConnection(connId);
    }
    shard.addConnection(connId, { playerId, lastSeq: 0, inputQueue: [], callsign: 'Pilot' });

    expect(shard.entities.size).toBe(1);
    expect(shard.playerShips.size).toBe(1);
  });

  describe('Docking State Machine', () => {
    it('should enter docked state when conditions are met', () => {
      const shipId = 'ship-1';
      const pad = shard.pads[0];
      
      shard.entities.set(shipId, {
        id: shipId,
        kind: 'ship',
        classId: 'scout',
        pos: { ...pad.pos, y: pad.pos.y + 0.5 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: 'surface',
        hull: 100,
        shields: 100,
        targetId: null,
      });

      shard.start();
      vi.advanceTimersByTime(50);

      const entity = shard.entities.get(shipId)!;
      expect(entity.dockedPadId).toBe(pad.id);
      shard.stop();
    });

    it('should not leave docked state within hysteresis band (20-25m)', () => {
      const shipId = 'ship-1';
      const pad = shard.pads[0];
      
      shard.entities.set(shipId, {
        id: shipId,
        kind: 'ship',
        classId: 'scout',
        pos: { ...pad.pos, y: pad.pos.y + 0.5 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: 'surface',
        hull: 100,
        shields: 100,
        targetId: null,
      });

      shard.start();
      vi.advanceTimersByTime(50);
      expect(shard.entities.get(shipId)!.dockedPadId).toBe(pad.id);

      shard.entities.get(shipId)!.pos.x += 22;
      vi.advanceTimersByTime(50);

      expect(shard.entities.get(shipId)!.dockedPadId).toBe(pad.id);

      shard.entities.get(shipId)!.pos.x += 4;
      vi.advanceTimersByTime(50);

      expect(shard.entities.get(shipId)!.dockedPadId).toBeUndefined();

      shard.stop();
    });

    it('should leave docked state on takeoff (vertical speed > 2)', () => {
      const shipId = 'ship-1';
      const pad = shard.pads[0];
      
      shard.entities.set(shipId, {
        id: shipId,
        kind: 'ship',
        classId: 'scout',
        pos: { ...pad.pos, y: pad.pos.y + 0.5 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        regime: 'surface',
        hull: 100,
        shields: 100,
        targetId: null,
      });

      shard.start();
      vi.advanceTimersByTime(50);
      expect(shard.entities.get(shipId)!.dockedPadId).toBe(pad.id);

      shard.entities.get(shipId)!.vel.y = 3;
      vi.advanceTimersByTime(50);

      expect(shard.entities.get(shipId)!.dockedPadId).toBeUndefined();

      shard.stop();
    });
  });
});
