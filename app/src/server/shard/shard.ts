import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

import { encodeMessage } from '@shared/protocol';
import { inputToShipInput } from '@shared/protocol/inputs';
import { messageSchemas, type EntityState, type InputPayload } from '@shared/protocol/schemas';
import {
  integrateShip,
  restShipState,
  type FlightOptions,
  type PlanetAtmo,
} from '@shared/physics/flight';
import { shipStats } from '@shared/ships';
import type { SystemGen } from '@shared/galaxy/types';
import type { Repository, ShipPosition } from '@server/db/repo';
import type { Conn } from '@server/ws';
import type { ShipSwapBus } from '@server/shards';
import { SimLoop } from './sim';
import { TickHistogram } from './histogram';
import { TerrainContext } from './terrain';
import {
  defaultLogger,
  type ConnState,
  type Shard,
  type ShardLogger,
  type SimEntity,
} from './types';

/** Sim tick period: 20 Hz. */
export const TICK_DT_MS = 50;
/** Snapshot cadence: 10 Hz = every 2nd tick. */
export const SNAPSHOT_EVERY_TICKS = 2;
/** Warn when a single broadcast exceeds this many bytes (TASK-60 tuning input). */
export const SNAPSHOT_WARN_BYTES = 32 * 1024;
/** Atmosphere density for planets that have one (flight-model units). */
export const ATMO_DENSITY = 0.1;

/** Zero control frame for players with nothing queued (coast). */
const ZERO_INPUT: InputPayload = {
  seq: 0,
  thrust: 0,
  turn: 0,
  pitch: 0,
  yaw: 0,
  fire: false,
  lock: false,
};

export interface CreateSystemShardOptions {
  systemId: string;
  /** Galaxy seed — regenerates the system's planets and surface chunks. */
  galaxySeed: string;
  /** The generated system (planets give the regime context). */
  system: SystemGen;
  /** Player ship lookup (entity spawn on join). */
  repo: Pick<Repository, 'getShipByOwner' | 'getPlayersByIds'>;
  /** Keep in-shard entities in sync with dock purchases / livery changes. */
  shipSwapBus: ShipSwapBus;
  persist?: (entities: EntityState[]) => void;
  log?: ShardLogger;
  dtMs?: number;
}

/**
 * The authoritative simulation for one star system (TASK-13).
 *
 * - SimLoop drives a fixed 1/20 s tick (drift-corrected, max 5-tick catch-up).
 * - Each tick drains every connection's input queue (latest input per player
 *   wins, stale seq ignored) and integrates the player's ship via the shared
 *   flight model with a per-entity regime context (planet density, O(1)
 *   chunk-cached terrain, landing pads).
 * - Every 2nd tick (10 Hz) the shard serializes an entity_update snapshot
 *   ONCE and sends the same buffer to every in-system connection.
 * - Per-tick wall-clock time feeds a ring-buffer histogram (p95 < 30 ms).
 *
 * AI ships are stubbed (kind 'ai-ship' entities exist as a type; they are
 * placed and steered in TASK-45/46).
 */
export class SystemShard implements Shard {
  readonly systemId: string;
  readonly sim: SimLoop;
  readonly connections = new Map<string, ConnState>();
  readonly entities = new Map<string, SimEntity>();
  readonly events = new EventEmitter();
  readonly persist: (entities: EntityState[]) => void;
  readonly histogram = new TickHistogram(2048);

  private readonly galaxySeed: string;
  private readonly system: SystemGen;
  private readonly repo: CreateSystemShardOptions['repo'];
  private readonly log: ShardLogger;
  private readonly dt: number; // seconds
  private readonly terrain = new Map<string, TerrainContext>();
  private readonly playerConns = new Map<string, string>();
  private readonly playerEntities = new Map<string, SimEntity>();
  private connSeq = 0;
  private offBus: (() => void) | undefined;
  private snapshotSizeWarned = false;

  constructor(options: CreateSystemShardOptions) {
    this.systemId = options.systemId;
    this.galaxySeed = options.galaxySeed;
    this.system = options.system;
    this.repo = options.repo;
    this.log = options.log ?? defaultLogger;
    this.dt = (options.dtMs ?? TICK_DT_MS) / 1000;
    this.persist = options.persist ?? (() => {});

    this.sim = new SimLoop({
      dtMs: options.dtMs ?? TICK_DT_MS,
      onTick: (tick) => {
        // A throwing tick must not kill the loop (single writer stays up).
        try {
          this.tick(tick);
        } catch (err) {
          this.log.warn(`tick ${tick} failed`, { error: String(err) });
        }
      },
    });

    // Keep in-shard entities in sync with dock purchases and livery changes.
    // The stable entity id mirrors the wire bridge: first swap takes over the
    // ship id clients currently hold, later swaps keep it.
    const bus = options.shipSwapBus;
    this.offBus = bus ? this.attachBus(bus) : undefined;
  }

  start(): void {
    this.sim.start();
  }

  /** Stop ticking and run the persist hook with the final snapshot. */
  stop(): void {
    this.sim.stop();
    this.persist(this.snapshot());
    this.offBus?.();
  }

  /**
   * Enqueue an 'input' frame for a joined player (called by the WS handler;
   * the ONLY mutation path outside the tick is this queue write).
   * Returns false when the frame was dropped (stale seq or the sim is
   * overloaded and dropping inputs).
   */
  enqueueInput(playerId: string, payload: InputPayload): boolean {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return false;
    if (this.sim.inputDrops) {
      this.log.debug('dropped input: sim overloaded', { playerId, seq: payload.seq });
      return false;
    }
    if (payload.seq <= conn.lastSeq) {
      this.log.debug('dropped stale input seq', {
        playerId,
        seq: payload.seq,
        lastSeq: conn.lastSeq,
      });
      return false;
    }
    conn.lastSeq = payload.seq;
    conn.input = payload; // latest input wins
    return true;
  }

  /** Join a connection: spawn (or re-adopt) the player's ship entity. */
  async join(conn: Conn): Promise<SimEntity | undefined> {
    if (conn.stage !== 'authed' || !conn.playerId || !conn.callsign) return undefined;
    const ship = await this.repo.getShipByOwner(conn.playerId);
    if (!ship) return undefined;

    let entity = this.playerEntities.get(conn.playerId);
    if (!entity) {
      entity = this.spawnEntity(
        conn.playerId,
        conn.callsign,
        ship.classId,
        ship.position,
        ship.id,
        {
          hull: ship.hull,
          shields: ship.shields,
          livery: ship.livery,
          docked: ship.state === 'docked',
        },
      );
      this.entities.set(entity.id, entity);
      this.playerEntities.set(conn.playerId, entity);
    }

    const connId = this.registerConnection(conn.playerId, conn.callsign, (buffer) => {
      if (conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(buffer);
      }
    });
    this.events.emit('player-joined', { playerId: conn.playerId, connId, entity });
    return entity;
  }

  /**
   * Register a connection (the WS layer does this via join(); programmatic
   * callers — the router in TASK-11 and tests — can use it directly).
   * Returns the connId.
   */
  registerConnection(playerId: string, callsign: string, send: ConnState['send']): string {
    const connId = `c${++this.connSeq}`;
    this.playerConns.set(playerId, connId);
    this.connections.set(connId, {
      connId,
      playerId,
      callsign,
      lastSeq: 0,
      appliedSeq: 0,
      ackSentSeq: 0,
      send,
    });
    return connId;
  }

  /** Remove a registered connection by connId. */
  unregisterConnection(connId: string): void {
    const state = this.connections.get(connId);
    if (!state) return;
    this.connections.delete(connId);
    this.playerConns.delete(state.playerId);
    // The held input belongs to the connection: without a pilot the ship
    // coasts on zero input instead of thrusting forever (TASK-14 hold
    // semantics). A re-join re-adopts the entity with a clean slate.
    const entity = this.playerEntities.get(state.playerId);
    if (entity) entity.heldInput = undefined;
    this.events.emit('player-left', { playerId: state.playerId, connId });
  }

  /** Leave: remove the connection; the entity stays in the world. */
  leave(conn: Conn): void {
    for (const state of this.connections.values()) {
      if (state.playerId === conn.playerId) {
        this.unregisterConnection(state.connId);
        break;
      }
    }
  }

  /**
   * Add an entity to the shard (join() does this for players; the AI
   * placement in TASK-45 and tests use it directly).
   */
  addEntity(entity: SimEntity): void {
    this.entities.set(entity.id, entity);
    if (entity.playerId) this.playerEntities.set(entity.playerId, entity);
  }

  /** Protocol snapshot of all entities (10 Hz broadcast payload, joined form). */
  snapshot(): EntityState[] {
    const out: EntityState[] = [];
    for (const entity of this.entities.values()) out.push(entityToState(entity));
    return out;
  }

  /** One sim tick: drain inputs, integrate, snapshot on even ticks. */
  private tick(tick: number): void {
    const t0 = performance.now();

    // Drain input queues: a new frame REPLACES the held frame (latest already
    // won at enqueue) and is held on the entity, re-integrated every tick
    // until a newer frame arrives — the client predictor keeps integrating
    // its last input between frames, so the authority must too (TASK-14).
    // Ships always integrate (the sim never pauses mid-flight); a player
    // that never sent a frame coasts on zero input.
    for (const conn of this.connections.values()) {
      const entity = this.playerEntities.get(conn.playerId);
      if (!entity) continue;
      const input = conn.input;
      if (input) {
        conn.input = undefined; // consumed: becomes the held frame
        entity.heldInput = input; // held until a newer frame replaces it
        conn.appliedSeq = input.seq; // TASK-14: reconcilable from this tick on
        if (entity.docked) entity.docked = false; // first input = take-off
      }
      const ctx = this.resolveRegimeCtx(entity);
      entity.ship = integrateShip(
        entity.ship,
        inputToShipInput(entity.heldInput ?? ZERO_INPUT),
        this.dt,
        entity.ship.regime,
        ctx.planet,
        shipStats(entity.classId),
        ctx.options,
      );
    }

    // 10 Hz snapshot: every 2nd tick, serialize ONCE, share the buffer.
    if (tick % SNAPSHOT_EVERY_TICKS === 0 && this.entities.size > 0 && this.connections.size > 0) {
      this.broadcast();
    }
    // 10 Hz acks: tell each connection the last input seq APPLIED (TASK-14).
    if (tick % SNAPSHOT_EVERY_TICKS === 0) this.sendAcks();

    const ms = performance.now() - t0;
    this.histogram.record(ms);
    this.events.emit('tick', { tick, ms, entities: this.entities.size });
  }

  private broadcast(): void {
    const payload = { entities: this.snapshot() };
    // Validate once against the wire contract (dev safety; cheap at 10 Hz).
    const check = messageSchemas.entity_update.safeParse(payload);
    if (!check.success) {
      this.log.warn('snapshot failed wire validation', {
        issue: check.error.issues[0]?.message,
      });
      return;
    }
    // Serialize ONCE; every in-system connection receives this same buffer.
    const buffer = encodeMessage('entity_update', payload);
    const bytes = buffer.length;
    if (bytes > SNAPSHOT_WARN_BYTES) {
      if (!this.snapshotSizeWarned) {
        this.log.warn('snapshot exceeds 32 KB — tuning input for TASK-60', { bytes });
        this.snapshotSizeWarned = true;
      }
    } else if (this.snapshotSizeWarned) {
      this.snapshotSizeWarned = false;
    }
    for (const conn of this.connections.values()) conn.send(buffer);
  }

  /**
   * TASK-14: tell each connection the last input seq APPLIED (integrated in
   * a tick), so the owning client can reconcile its prediction. Sent at
   * snapshot cadence and only when it advanced. This is a per-connection
   * message on purpose: the shared entity_update buffer must stay
   * byte-identical for every in-system peer (the encode-once design), so
   * the ack cannot ride in the snapshot payload.
   */
  private sendAcks(): void {
    for (const conn of this.connections.values()) {
      if (conn.appliedSeq > conn.ackSentSeq) {
        conn.send(encodeMessage('ack', { seq: conn.appliedSeq }));
        conn.ackSentSeq = conn.appliedSeq;
      }
    }
  }

  /**
   * Resolve the flight-model context for an entity: its regime decides the
   * planet context (atmosphere density, O(1) chunk-cached terrain, pads).
   * Space entities get no planet context at all.
   */
  private resolveRegimeCtx(entity: SimEntity): { planet?: PlanetAtmo; options: FlightOptions } {
    const empty = {
      planet: undefined as PlanetAtmo | undefined,
      options: { heightAt: () => 0, pads: [] },
    };
    if (entity.ship.regime === 'space' || !entity.planetId) return empty;
    const planet = this.system.planets.find((p) => p.id === entity.planetId);
    if (!planet) return empty;
    const ctx = this.getTerrain(planet.id);
    ctx.update(entity.ship.pos.x, entity.ship.pos.z);
    return {
      planet: planet.hasAtmosphere ? { atmosphereDensity: ATMO_DENSITY } : undefined,
      options: {
        heightAt: (x, z) => ctx.heightAt(x, z),
        pads: ctx.pads(),
      },
    };
  }

  private getTerrain(planetId: string): TerrainContext {
    let ctx = this.terrain.get(planetId);
    if (!ctx) {
      const planet = this.system.planets.find((p) => p.id === planetId);
      if (!planet) throw new Error(`unknown planet id: ${planetId}`);
      ctx = new TerrainContext(this.galaxySeed, planet);
      this.terrain.set(planetId, ctx);
    }
    return ctx;
  }

  private spawnEntity(
    playerId: string,
    callsign: string,
    classId: string,
    position: ShipPosition,
    shipEntityId: string,
    combat: { hull: number; shields: number; livery?: Record<string, unknown>; docked: boolean },
  ): SimEntity {
    const cls = shipStats(classId);
    const pos = { x: position.x, y: position.y, z: position.z };
    const livery: Record<string, string> = {};
    for (const [key, value] of Object.entries(combat.livery ?? {})) {
      if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) livery[key] = value;
    }
    return {
      // Ship id = the wire-stable entity id clients hold (bridge + purchases).
      id: shipEntityId,
      kind: 'ship',
      playerId,
      callsign,
      classId,
      ship: restShipState(pos, 'space'),
      hull: Math.min(1, cls.hull > 0 ? combat.hull / cls.hull : 0),
      shields: Math.min(1, cls.shieldCapacity > 0 ? combat.shields / cls.shieldCapacity : 0),
      targetId: null,
      livery: Object.keys(livery).length > 0 ? livery : undefined,
      docked: combat.docked,
    };
  }

  /** Dock purchases / livery edits replace the in-shard entity in place. */
  private attachBus(bus: ShipSwapBus): () => void {
    const offSwap = bus.onSwap(async ({ playerId, ship }) => {
      const entity = this.playerEntities.get(playerId);
      if (!entity) return;
      entity.classId = ship.classId;
      const cls = shipStats(ship.classId);
      entity.hull = Math.min(1, cls.hull > 0 ? ship.hull / cls.hull : 0);
      entity.shields = Math.min(1, cls.shieldCapacity > 0 ? ship.shields / cls.shieldCapacity : 0);
      entity.docked = ship.state === 'docked';
      entity.ship.pos = { x: ship.position.x, y: ship.position.y, z: ship.position.z };
      entity.ship.vel = { x: 0, y: 0, z: 0 };
      const livery: Record<string, string> = {};
      for (const [key, value] of Object.entries(ship.livery ?? {})) {
        if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) livery[key] = value;
      }
      entity.livery = Object.keys(livery).length > 0 ? livery : undefined;
      this.log.debug('entity updated from ship swap', { playerId, classId: ship.classId });
    });
    const offLivery = bus.onLivery(async ({ playerId, livery }) => {
      const entity = this.playerEntities.get(playerId);
      if (!entity) return;
      entity.livery = livery;
    });
    return () => {
      offSwap();
      offLivery();
    };
  }
}

// `inputToShipInput` moved to @shared/protocol/inputs (TASK-14) — the client
// predictor maps frames identically. Re-exported so existing imports work.
export { inputToShipInput };

/** Entity → wire EntityState (hull/shields normalized 0..1, regime mapped). */
export function entityToState(e: SimEntity): EntityState {
  // Wire regimes v1: docked (at a dock or settled on a pad) vs sublight flight.
  const regime: EntityState['regime'] = e.docked || e.ship.onPad ? 'docked' : 'sublight';
  const state: EntityState = {
    id: e.id,
    kind: e.kind,
    pos: e.ship.pos,
    vel: e.ship.vel,
    rot: e.ship.quat, // TASK-14: reconciliation + remote slerp
    regime,
    hull: e.hull,
    shields: e.shields,
    targetId: e.targetId,
    classId: e.classId,
  };
  if (e.callsign) state.callsign = e.callsign;
  if (e.livery) state.livery = e.livery;
  return state;
}
