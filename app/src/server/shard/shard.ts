import { EventEmitter } from 'events';
import { SimLoop } from './sim';
import { ServerShipState, ConnState } from './types';
import { integrateShip } from '../../shared/physics/flight';
import { FlightRegime, Planet } from '../../shared/physics/types';
import { ShipClass } from '../../shared/ships';
import { performance } from 'perf_hooks';

export class Shard extends EventEmitter {
  public entities = new Map<string, ServerShipState>();
  public connections = new Map<string, ConnState>();
  public playerShips = new Map<string, string>(); // playerId -> shipId
  public sim: SimLoop;
  private tickCount = 0;
  private tickDurations: number[] = [];
  private maxHistogramSize = 1000;

  constructor(public readonly systemId: string) {
    super();
    this.sim = new SimLoop(20, (dt) => this.onTick(dt));
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
    if (!conn) return;

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

    // 1. Drain inputs and integrate ships
    for (const [connId, conn] of this.connections) {
      if (conn.inputQueue.length === 0) continue;

      // Latest input per player wins
      const input = conn.inputQueue.pop()!;
      conn.inputQueue = []; // Clear the rest

      const shipId = this.playerShips.get(conn.playerId);
      if (!shipId) continue;

      const entity = this.entities.get(shipId);
      if (!entity) continue;

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

      const newState = integrateShip(
        entity,
        flightInput,
        dt,
        regime,
        shipClass,
        planet,
        {
          heightAt: (x: number, z: number) => 0, // stubbed heightAt
        }
      );

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
    const entities = Array.from(this.entities.values()).map(e => ({
      id: e.id,
      kind: 'ship',
      pos: e.pos,
      vel: e.vel,
      quat: e.quat,
      regime: e.regime,
      hull: e.hull,
      shields: e.shields,
      targetId: e.targetId,
      classId: 'default', // Stub
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

  private resolveRegime(entity: ServerShipState): { regime: FlightRegime, planet?: Planet } {
    return { regime: entity.regime as FlightRegime };
  }

  private getShipClass(entity: ServerShipState): ShipClass {
    return {
      id: 'default',
      name: 'Default Ship',
      mass: 1000,
      acceleration: 10,
      maxVelocity: 100,
      turnRate: 1,
    };
  }
}
