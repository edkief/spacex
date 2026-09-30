import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

import { encodeMessage } from '@shared/protocol';
import { inputToShipInput } from '@shared/protocol/inputs';
import {
  chatMessageSchema,
  messageSchemas,
  type ChatMessage,
  type EntityState,
  type InputPayload,
  type PayloadSchemas,
} from '@shared/protocol/schemas';
import { CHAT_HISTORY_MAX } from '@shared/chat';
import { applyDamage, type ApplyDamageResult, type DamageSource } from '@shared/physics/damage';
import { integrateShip, type FlightOptions, type PlanetAtmo } from '@shared/physics/flight';
import { quatIdentity, type Quat } from '@shared/physics/vec';
import { shipStats, HEX_COLOR } from '@shared/ships';
import type { SystemGen } from '@shared/galaxy/types';
import { homeDockPosition } from '@shared/galaxy/dock';
import type { Repository } from '@server/db/repo';
import type { ShipRow } from '@server/db/schema';
import type { ShipsLoad } from './persist';
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
/** Wrecks (TASK-23) stay in the shard for 600 s, then are removed. */
export const WRECK_TTL_MS = 600_000;

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

/** True for a finite 4-component quaternion (guards corrupt persisted rows). */
function isQuat(value: unknown): value is Quat {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Record<string, unknown>;
  return ['x', 'y', 'z', 'w'].every((k) => typeof q[k] === 'number' && Number.isFinite(q[k]));
}

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
  /** Injectable clock (tests use a fake now for destruction timestamps). */
  now?: () => number;
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
  private readonly now: () => number;
  private readonly dt: number; // seconds
  /** Wreck ttl in TICKS (600 s at the shard's dt; 20 Hz → 12 000). */
  private readonly wreckTtlTicks: number;
  /** TASK-16: system chat ring buffer (last 100) + last assigned ts. */
  private readonly chatLog: ChatMessage[] = [];
  private lastChatTs = 0;
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
    this.now = options.now ?? (() => Date.now());
    this.dt = (options.dtMs ?? TICK_DT_MS) / 1000;
    this.wreckTtlTicks = Math.max(1, Math.round(WRECK_TTL_MS / (options.dtMs ?? TICK_DT_MS)));
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
   * Returns false when the frame was dropped (stale seq, stale connection
   * identity after a reconnect, or the sim is overloaded and dropping
   * inputs).
   */
  enqueueInput(playerId: string, payload: InputPayload, source?: unknown): boolean {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return false;
    // TASK-17: inputs must come from the player's CURRENT connection. After
    // a reconnect the old (zombie) socket still resolves to the same
    // playerId — its frames are dropped with a debug log, never applied.
    if (source !== undefined && conn.source !== source) {
      this.log.debug('dropped input from stale conn', { playerId, connId, seq: payload.seq });
      return false;
    }
    // TASK-23: destroyed ships ignore inputs (frozen until dock respawn).
    const entity = this.playerEntities.get(playerId);
    if (entity?.destroyed) {
      this.log.debug('dropped input: ship destroyed', { playerId, seq: payload.seq });
      return false;
    }
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

  /**
   * Spawn (or re-adopt) the player's ship entity WITHOUT registering a
   * connection. The router (TASK-11) calls this after it has already
   * reserved the connection slot, so the cap check + reservation stays
   * atomic; tests can use it for headless joins.
   */
  async adoptEntity(playerId: string, callsign: string): Promise<SimEntity | undefined> {
    const ship = await this.repo.getShipByOwner(playerId);
    if (!ship) return undefined;

    let entity = this.playerEntities.get(playerId);
    if (!entity) {
      // TASK-24: the entity spawns with the ship's PERSISTED flight state
      // (pos/vel/quat/regime), not a fresh rest state — no teleports.
      entity = this.entityFromShipRow(ship, callsign);
      this.entities.set(entity.id, entity);
      this.playerEntities.set(playerId, entity);
    }
    // TASK-17: re-adopting the ship of a reconnecting player (the entity
    // already exists, still at its idle position) un-idles it. A headless
    // adopt (no connection) stays idle.
    entity.idle = !this.playerConns.has(playerId);
    return entity;
  }

  /** Join a connection: adopt the player's ship entity, then register. */
  async join(conn: Conn): Promise<SimEntity | undefined> {
    if (conn.stage !== 'authed' || !conn.playerId || !conn.callsign) return undefined;
    const entity = await this.adoptEntity(conn.playerId, conn.callsign);
    if (!entity) return undefined;

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
   *
   * TASK-17: if the player already holds a (zombie) connection, it is
   * SUPERSEDED here — evicted from the shard before the new one registers,
   * so a reconnect can never leave two live connections (two slots, two
   * integrations) for one ship. The entity itself stays untouched.
   */
  registerConnection(playerId: string, callsign: string, send: ConnState['send'], source?: unknown): string {
    const staleId = this.playerConns.get(playerId);
    if (staleId && this.connections.has(staleId)) {
      this.connections.delete(staleId);
      this.log.debug('superseded stale connection', { playerId, connId: staleId });
    }
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
      ...(source !== undefined ? { source } : {}),
    });
    // TASK-17: the ship is piloted again (covers the join-order where the
    // entity was adopted BEFORE the connection registered).
    const entity = this.playerEntities.get(playerId);
    if (entity) entity.idle = false;
    return connId;
  }

  /**
   * Remove a registered connection by connId. The entity STAYS in the world:
   * it goes idle (coasts on zero input, TASK-17) until the player re-joins.
   */
  unregisterConnection(connId: string): void {
    const state = this.connections.get(connId);
    if (!state) return;
    this.connections.delete(connId);
    // TASK-17: a connId is only unregistered by PLAYER when it is still the
    // player's CURRENT connection — a late close of a superseded zombie
    // socket must not tear down the new connection.
    const isCurrent = this.playerConns.get(state.playerId) === connId;
    if (isCurrent) {
      this.playerConns.delete(state.playerId);
      // The held input belongs to the connection: without a pilot the ship
      // coasts on zero input instead of thrusting forever (TASK-14 hold
      // semantics). A re-join re-adopts the entity with a clean slate.
      const entity = this.playerEntities.get(state.playerId);
      if (entity) {
        entity.heldInput = undefined;
        entity.idle = true;
      }
    } else {
      this.log.debug('dropped stale connection on leave', {
        playerId: state.playerId,
        connId,
      });
    }
    this.events.emit('player-left', { playerId: state.playerId, connId });
  }

  /**
   * Leave by player id (the router's leave path, TASK-11): remove the
   * player's connection; the entity stays in the world (idle, TASK-17).
   * When `source` is given, a leave from a SUPERSEDED connection (a zombie
   * socket of a reconnected player) is ignored with a debug log — it must
   * not evict the player's current connection.
   */
  leavePlayer(playerId: string, source?: unknown): void {
    const connId = this.playerConns.get(playerId);
    if (!connId) return;
    if (source !== undefined) {
      const state = this.connections.get(connId);
      if (state && state.source !== source) {
        this.log.debug('ignored leave from stale conn', { playerId, connId });
        return;
      }
    }
    this.unregisterConnection(connId);
  }

  /** Leave: remove the connection; the entity stays in the world. */
  leave(conn: Conn): void {
    if (conn.playerId) this.leavePlayer(conn.playerId);
  }

  /**
   * Add an entity to the shard (join() does this for players; the AI
   * placement in TASK-45 and tests use it directly).
   */
  addEntity(entity: SimEntity): void {
    this.entities.set(entity.id, entity);
    if (entity.playerId) this.playerEntities.set(entity.playerId, entity);
  }

  /**
   * TASK-16: system text chat. The inbound frame was schema-validated,
   * sanitized, and per-connection rate-limited (5 / 10 s) by the WS layer
   * before it arrives; the shard owns the rest:
   * - server ts (ms epoch, strictly monotonic per shard so every client
   *   orders the log identically),
   * - the 100-message ring buffer (join-snapshot history, cleared on shard
   *   reap — no persistence in v1),
   * - encode-once broadcast to EVERY in-system connection, sender echo
   *   included. No channels, no private messages in v1.
   */
  handleChat(from: string, text: string): void {
    const ts = Math.max(this.now(), this.lastChatTs + 1);
    const message = { from, text, ts } satisfies ChatMessage;
    // Validate once against the wire contract (dev safety, mirrors broadcast()).
    const check = chatMessageSchema.safeParse(message);
    if (!check.success) {
      this.log.warn('chat message failed wire validation', {
        issue: check.error.issues[0]?.message,
      });
      return;
    }
    this.lastChatTs = ts;
    this.chatLog.push(message);
    if (this.chatLog.length > CHAT_HISTORY_MAX) {
      this.chatLog.splice(0, this.chatLog.length - CHAT_HISTORY_MAX);
    }
    const buffer = encodeMessage('chat', message);
    for (const conn of this.connections.values()) conn.send(buffer);
  }

  /** The shard's chat history (last 100 messages; join snapshots, TASK-16). */
  chatHistory(): ChatMessage[] {
    return this.chatLog;
  }

  /**
   * TASK-23: a weapon hit lands on the target (the sim-side hook; real
   * weapons wire in TASK-43). Applies the shared damage model — shields
   * absorb first, overflow reaches the hull — and broadcasts a combat_event
   * to the WHOLE shard: 'damaged' per hit, or 'destroyed' on the killing hit.
   *
   * A killing hit destroys the ship: it stops integrating, ignores inputs,
   * becomes non-targetable, and a static wreck (kind 'wreck', 600 s ttl)
   * takes its final position. The ship entity itself stays frozen (hull 0 on
   * the wire) until the dock respawn (TASK-49).
   *
   * Returns the damage result, or undefined when the target is unknown, a
   * wreck, or already destroyed (the double-destroy guard: no second
   * destroyed event, no second wreck).
   */
  applyHit(targetId: string, amount: number, source: DamageSource): ApplyDamageResult | undefined {
    const entity = this.entities.get(targetId);
    if (!entity || entity.kind === 'wreck' || entity.destroyed) return undefined;
    const cls = shipStats(entity.classId);
    // Sim entities keep normalized 0..1 fractions; the shared model works in
    // absolute points against the class caps.
    const result = applyDamage(
      {
        hull: entity.hull * cls.hull,
        shields: entity.shields * cls.shieldCapacity,
      },
      amount,
      source,
    );
    const hullCap = cls.hull > 0 ? cls.hull : 1;
    const shieldCap = cls.shieldCapacity > 0 ? cls.shieldCapacity : 1;
    entity.shields = Math.max(0, entity.shields - result.shieldHit / shieldCap);
    entity.hull = Math.max(0, entity.hull - result.hullHit / hullCap);
    if (result.destroyed) {
      this.destroyEntity(entity, source);
    } else {
      this.broadcastCombatEvent({
        kind: 'damaged',
        target: entity.id,
        source,
        amount,
        shieldHit: result.shieldHit,
        hullHit: result.hullHit,
      });
    }
    return result;
  }

  /**
   * Destroy a ship (the killing step of applyHit): freeze it (hull/shields 0,
   * no held input, no target) and spawn a static wreck at its final position
   * with the 600 s ttl. The wreck is a NEW entity (id `wreck:<shipId>`) so
   * the frozen ship — which a dock respawn re-adopts in TASK-49 — and the
   * expiring wreck are independent.
   */
  private destroyEntity(entity: SimEntity, source: DamageSource): void {
    entity.destroyed = true;
    entity.destroyedAtMs = this.now(); // TASK-24: wreck ttl anchor for the flush
    entity.hull = 0;
    entity.shields = 0;
    entity.targetId = null;
    entity.heldInput = undefined;
    const connId = entity.playerId ? this.playerConns.get(entity.playerId) : undefined;
    if (connId) {
      const conn = this.connections.get(connId);
      if (conn) conn.input = undefined; // queued input is moot: the ship is gone
    }
    this.entities.set(`wreck:${entity.id}`, {
      id: `wreck:${entity.id}`,
      kind: 'wreck',
      playerId: null,
      classId: entity.classId,
      ship: {
        pos: { ...entity.ship.pos },
        vel: { x: 0, y: 0, z: 0 },
        quat: { ...entity.ship.quat },
        regime: entity.ship.regime,
      },
      hull: 0,
      shields: 0,
      targetId: null,
      docked: false, // static wreck: sublight wire regime at zero velocity
      ttl: this.wreckTtlTicks,
    });
    this.broadcastCombatEvent({ kind: 'destroyed', target: entity.id, source });
    this.log.info('ship destroyed', {
      target: entity.id,
      source: source.id,
      wreck: `wreck:${entity.id}`,
    });
  }

  /**
   * Encode-once combat_event to every in-system connection (the shard is the
   * whole broadcast scope in v1). Validated against the wire contract first,
   * mirroring the snapshot path (a failing event must never crash the tick).
   */
  private broadcastCombatEvent(payload: PayloadSchemas['combat_event']): void {
    const check = messageSchemas.combat_event.safeParse(payload);
    if (!check.success) {
      this.log.warn('combat event failed wire validation', {
        issue: check.error.issues[0]?.message,
      });
      return;
    }
    const buffer = encodeMessage('combat_event', check.data);
    for (const conn of this.connections.values()) conn.send(buffer);
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

    // TASK-23: expire static wrecks (600 s ttl) — bounds the entity count.
    for (const [id, entity] of this.entities) {
      if (entity.ttl !== undefined && --entity.ttl === 0) this.entities.delete(id);
    }

    // Integrate EVERY player ship — connected or not. A ship whose owner
    // has no live connection is IDLE (TASK-17): its held frame was cleared
    // when the owner left, so it coasts on zero input and the world keeps
    // living while the player is away (no world reset on drop). A new
    // frame REPLACES the held frame (latest already won at enqueue) and is
    // held on the entity, re-integrated every tick until a newer frame
    // arrives — the client predictor keeps integrating its last input
    // between frames, so the authority must too (TASK-14). A player that
    // never sent a frame coasts on zero input. Destroyed ships (TASK-23)
    // stop integrating and ignore inputs entirely.
    for (const entity of this.playerEntities.values()) {
      if (entity.destroyed) continue;
      const connId = entity.playerId ? this.playerConns.get(entity.playerId) : undefined;
      const conn = connId ? this.connections.get(connId) : undefined;
      const input = conn?.input;
      if (conn && input) {
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

  /**
   * TASK-24: build a sim entity from a persisted ship row. Used both by join
   * (the player's ship appears with its last saved flight state — no
   * teleports) and by loadShips (shard restart). Corrupt/missing fields fall
   * back to safe defaults (identity quat, space regime) so one bad row can
   * never wedge the shard.
   */
  private entityFromShipRow(ship: ShipRow, callsign?: string): SimEntity {
    const cls = shipStats(ship.classId);
    const docked = ship.state === 'docked';
    // Docked ships always load at the system dock (the row's position is the
    // home-system dock of a possibly different system; this system's dock is
    // the canonical resting spot, seed-derived like everything else).
    const dock = homeDockPosition(this.galaxySeed, this.systemId);
    const pos = docked
      ? { x: dock.x, y: dock.y, z: dock.z }
      : { x: ship.position.x, y: ship.position.y, z: ship.position.z };
    const quat = isQuat(ship.rotation) ? { ...ship.rotation } : quatIdentity();
    const regime: SimEntity['ship']['regime'] =
      ship.regime === 'atmosphere' ? 'atmosphere' : 'space';
    const livery: Record<string, string> = {};
    for (const [key, value] of Object.entries(ship.livery ?? {})) {
      if (typeof value === 'string' && HEX_COLOR.test(value)) livery[key] = value;
    }
    const state = {
      pos,
      vel: docked ? { x: 0, y: 0, z: 0 } : { ...ship.velocity },
      quat,
      regime,
      ...(ship.onPad && !docked ? { onPad: ship.onPad } : {}),
    };
    return {
      // Ship id = the wire-stable entity id clients hold (bridge + purchases).
      id: ship.id,
      kind: 'ship',
      playerId: ship.ownerId,
      callsign,
      classId: ship.classId,
      ship: state,
      hull: Math.min(1, cls.hull > 0 ? ship.hull / cls.hull : 0),
      shields: Math.min(1, cls.shieldCapacity > 0 ? ship.shields / cls.shieldCapacity : 0),
      targetId: null,
      livery: Object.keys(livery).length > 0 ? livery : undefined,
      docked,
      destroyed: ship.state === 'destroyed',
      destroyedAtMs: ship.destroyedAt ? Date.parse(ship.destroyedAt) : undefined,
    };
  }

  /**
   * TASK-24: shard-spawn load — rebuild the sim from the persisted ships of
   * this system (the result of ShardPersist.loadShips). Flying/on-foot ships
   * come back with their saved state; docked ships at dock coords; unexpired
   * destroyed ships as static wrecks with their remaining ttl. Entities that
   * are already in the shard are never clobbered.
   */
  async loadShips(load: ShipsLoad): Promise<{ ships: number; wrecks: number }> {
    const owners = [...new Set(load.ships.map((r) => r.ownerId))];
    const callsigns = new Map(
      (await this.repo.getPlayersByIds(owners)).map((p) => [p.id, p.callsign]),
    );
    let ships = 0;
    for (const row of load.ships) {
      if (this.playerEntities.has(row.ownerId)) continue; // already in-shard
      const entity = this.entityFromShipRow(row, callsigns.get(row.ownerId));
      this.entities.set(entity.id, entity);
      this.playerEntities.set(row.ownerId, entity);
      ships += 1;
    }
    let wrecks = 0;
    for (const { row, remainingMs } of load.wrecks) {
      if (this.entities.has(`wreck:${row.id}`)) continue;
      this.entities.set(`wreck:${row.id}`, {
        id: `wreck:${row.id}`,
        kind: 'wreck',
        playerId: null,
        classId: row.classId,
        ship: {
          pos: { x: row.position.x, y: row.position.y, z: row.position.z },
          vel: { x: 0, y: 0, z: 0 },
          quat: isQuat(row.rotation) ? { ...row.rotation } : quatIdentity(),
          regime: row.regime === 'atmosphere' ? 'atmosphere' : 'space',
        },
        hull: 0,
        shields: 0,
        targetId: null,
        docked: false,
        ttl: Math.max(1, Math.round(remainingMs / (this.dt * 1000))),
      });
      wrecks += 1;
    }
    this.log.info('shard loaded persisted state', {
      systemId: this.systemId,
      ships,
      wrecks,
      deletedExpired: load.deletedExpired,
    });
    return { ships, wrecks };
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
      // A dock repair (TASK-23 reuses this event) must also REVIVE a
      // destroyed in-shard entity: clear the flag and the stale held frame.
      if (entity.hull > 0) {
        entity.destroyed = false;
        entity.heldInput = undefined;
      }
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
