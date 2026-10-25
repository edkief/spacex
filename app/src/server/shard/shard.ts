import { EventEmitter } from 'events';
import { SimLoop } from './sim';
import { ServerShipState, ConnState } from './types';
import { integrateShip } from '../../shared/physics/flight';
import { FlightRegime, Planet } from '../../shared/physics/types';
import { ShipClass, SHIP_CLASSES, shipStats, ShipClassId } from '../../shared/ships';
import { performance } from 'perf_hooks';
import { cleanupExpiredWrecks } from './combat';
import { gameEvents, GameEventType } from '../events';
import { persistService } from '../persist';

export class Shard extends EventEmitter {
  public entities = new Map<string, ServerShipState>();
  public connections = new Map<string, ConnState>();
  public playerShips = new Map<string, string>(); // playerId -> shipId
  public sim: SimLoop;
  public generation = 0;
  private tickCount = 0;
  private tickDurations: number[] = [];
  private maxHistogramSize = 1000;

  constructor(public readonly systemId: string) {
    super();
    this.sim = new SimLoop(20, (dt) => this.onTick(dt));

    gameEvents.on(GameEventType.REPAIR_COMPLETED, ({ playerId, shipId }) => {
      const entity = this.entities.get(shipId);
      if (entity) {
        const stats = this.getShipClass(entity);
        entity.hull = stats.hull;
        entity.shields = stats.shieldCapacity;
      }
    });

    gameEvents.on(GameEventType.SHIP_SWAPPED, ({ playerId, newShip }) => {
      const shipId = this.playerShips.get(playerId);
      if (shipId) {
        this.entities.set(shipId, {
          ...newShip,
          id: shipId,
          kind: 'ship',
          // Map DB fields to SimEntity fields
          hull: newShip.hull,
          shields: newShip.shields,
          destroyed: false,
          // ... other fields
        } as any);
      }
    });
  }

  public broadcast(type: string, payload: any) {
    const data = JSON.stringify(payload);
    for (const [connId] of this.connections) {
      this.emit('send', connId, type, data);
    }
  }

  public addConnection(connId: string, conn: ConnState) {
    this.connections.set(connId, conn);
    this.broadcast('presence_join', {
      playerId: connId,
      callsign: conn.callsign,
    });
  }

  public removeConnection(connId: string) {
    if (this.connections.has(connId)) {
      this.connections.delete(connId);
      this.broadcast('presence_leave', { playerId: connId });
    }
  }

  public handleChat(connId: string, text: string) {
    const conn = this.connections.get(connId);
    if (!conn) return { success: false, code: 'not-found' };

    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 200) {
      return { success: false, code: 'invalid-message' };
    }

    // Sanitization: strip control characters and non-text
    const sanitized = trimmed.replace(/[\\x00-\\x1F\\x7F]/g, '');

    const chatMsg = {
      from: conn.callsign,
      text: sanitized,
      ts: Date.now(),
    };

    this.broadcast('chat', chatMsg);
    return { success: true };
  }

  public spawnShip(playerId: string, shipId: string, pos: { x: number, y: number, z: number }, shipData: any) {
    this.playerShips.set(playerId, shipId);
    this.entities.set(shipId, {
      ...shipData,
      id: shipId,
      kind: 'ship',
      pos,
      vel: { x: 0, y: 0, z: 0 },
      destroyed: false,
      lastAppliedSeq: 0,
    } as ServerShipState);

    this.broadcast('presence_join', {
      playerId,
      callsign: this.connections.get(playerId)?.callsign || 'Unknown',
    });
  }

  public getSnapshot() {
    return Array.from(this.entities.values()).map((e) => ({
      id: e.id,
      kind: e.kind,
      pos: e.pos,
      vel: e.vel,
      quat: e.quat,
      regime: e.regime,
      hull: e.hull,
      shields: e.shields,
      targetId: e.targetId,
      classId: e.classId,
      lastAppliedSeq: e.lastAppliedSeq,
    }));
  }

  start() {
    this.sim.start();
  }

  stop() {
    this.sim.stop();
  }

  /**
   * Handles an inbound input message from a client.
   */
  public handleInput(connId: string, input: any) {
    const conn = this.connections.get(connId);
    if (!conn) {
      console.debug(`[Shard ${this.systemId}] Dropping input from stale connId: ${connId}`);
      return;
    }

    // Out-of-order protection: ignore stale seq
    if (input.seq <= conn.lastSeq) {
      // Log drop at debug level (simplified)
      return;
    }

    conn.lastSeq = input.seq;
    conn.inputQueue.push(input);
  }

  private onTick(dt: number) {
    const start = performance.now();
    this.tickCount++;

    // 0. Cleanup
    if (this.tickCount % 100 === 0) {
      cleanupExpiredWrecks(this);
    }

    // Periodic flush every 30s (20Hz * 30)
    if (this.tickCount % 600 === 0) {
      persistService
        .flushShips(this.systemId, this.entities)
        .catch((err) => console.error(`Flush error in shard ${this.systemId}:`, err));
    }

    // 1. Drain inputs and integrate ships
    for (const [connId, conn] of this.connections) {
      if (conn.inputQueue.length === 0) continue;

      // Latest input per player wins
      const input = conn.inputQueue.pop()!;
      conn.inputQueue = []; // Clear the rest

      const shipId = this.playerShips.get(conn.playerId);
      if (!shipId) continue;

      const entity = this.entities.get(shipId);
      if (!entity || entity.destroyed || entity.kind === 'wreck') continue;

      const { regime, planet } = this.resolveRegime(entity);
      const shipClass = this.getShipClass(entity);

      // Map InputMsg to FlightInput
      const flightInput = {
        thrust: input.thrust,
        pitch: input.pitch,
        yaw: input.yaw,
        roll: input.turn, // mapping 'turn' to 'roll'
        up: false, // missing in InputSchema, stubbed
      };

      const newState = integrateShip(entity, flightInput, dt, regime, shipClass, planet, {
        heightAt: (x: number, z: number) => 0, // stubbed heightAt
      });

      // Update entity state (keeping combat-ready fields)
      this.entities.set(shipId, {
        ...entity,
        ...newState,
        id: shipId,
        hull: entity.hull,
        shields: entity.shields,
        targetId: entity.targetId,
        lastAppliedSeq: input.seq,
      });
    }

    // 2. Handle AI ships (stub until TASK-46)
    // for (const [id, entity] of this.entities) { ... }

    // 3. Snapshot broadcast (10 Hz)
    if (this.tickCount % 2 === 0) {
      this.broadcastSnapshot();
    }

    const end = performance.now();
    this.tickDurations.push(end - start);
    if (this.tickDurations.length > this.maxHistogramSize) {
      this.tickDurations.shift();
    }

    this.emit('tick', dt);
  }

  public getTimingStats() {
    if (this.tickDurations.length === 0) return null;
    const sorted = [...this.tickDurations].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    return { p50, p95, p99, count: sorted.length };
  }

  private broadcastSnapshot() {
    const entities = Array.from(this.entities.values()).map((e) => ({
      id: e.id,
      kind: e.kind,
      pos: e.pos,
      vel: e.vel,
      quat: e.quat,
      regime: e.regime,
      hull: e.hull,
      shields: e.shields,
      targetId: e.targetId,
      classId: e.classId,
      callsign: 'Unknown', // Stub
      lastAppliedSeq: e.lastAppliedSeq,
    }));

    const payload = JSON.stringify({ entities });
    const size = Buffer.byteLength(payload);

    if (size > 32 * 1024) {
      console.warn(`Snapshot size too large: ${size} bytes`);
    }

    for (const [connId] of this.connections) {
      this.emit('send', connId, 'entity_update', payload);
    }
  }

  private resolveRegime(entity: ServerShipState): { regime: FlightRegime; planet?: Planet } {
    return { regime: entity.regime as FlightRegime };
  }

  private getShipClass(entity: ServerShipState): ShipClass {
    return shipStats(entity.classId as ShipClassId);
  }
}
