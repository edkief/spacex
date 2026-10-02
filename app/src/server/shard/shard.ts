import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

import { encodeMessage } from '@shared/protocol';
import { inputToCharacterInput, inputToShipInput } from '@shared/protocol/inputs';
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
import { quatIdentity, vecLength, vecSub, type Quat, type Vec3 } from '@shared/physics/vec';
import {
  applyVtolAssist,
  DOCK_VERTICAL_SPEED_MAX_M_S,
  padSurfaceHeight,
  padsForSystem,
  resolvePadTarget,
  satisfiesDock,
  vtolAssistActive,
  type PadInfo,
} from '@shared/world/pads';
import {
  DEPOSIT_DISCOVERY_RADIUS_M,
  DEPOSIT_RENDER_RANGE_M,
  depositsFor,
  type Deposit,
} from '@shared/world/deposits';
import {
  characterSpawnPos,
  integrateCharacter,
  type CharacterState,
} from '@shared/physics/character';
import {
  ENTER_SHIP_MAX_SPEED,
  ENTER_SHIP_RANGE_M,
  INTERACT_RANGE_M,
  interactRangeFor,
  isInteractableKind,
} from '@shared/interaction';
import {
  dropFrom,
  emptyInventory,
  isResourceId,
  parseInventoryJson,
  pickupInto,
  sanitizeInventory,
  toPlayerInventory,
  type InventoryStacks,
  type ResourceId,
} from '@shared/inventory';
import { shipStats, HEX_COLOR } from '@shared/ships';
import type { SystemGen } from '@shared/galaxy/types';
import { homeDockPosition } from '@shared/galaxy/dock';
import {
  planetAtmosphereDensity,
  planetAtmosphereRadius,
  systemRegimePlanets,
} from '@shared/galaxy/planets';
import { regimeFor, type RegimePlanet } from '@shared/regime';
import type { Repository } from '@server/db/repo';
import type { DepositRow, ShipRow } from '@server/db/schema';
import { validRegime, type ShipsLoad } from './persist';
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
/**
 * Per-planet atmosphere context for the flight model (TASK-28): density and
 * the shared 1 km enter radius come from the seeded planet data (both pure
 * functions of the planet — server and client derive identical values).
 */
/** Wrecks (TASK-23) stay in the shard for 600 s, then are removed. */
export const WRECK_TTL_MS = 600_000;
/** TASK-34: dropped ground items persist 300 s, then despawn. */
export const GROUND_ITEM_TTL_MS = 300_000;

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
  repo: Pick<Repository, 'getShipByOwner' | 'getPlayersByIds'> &
    /** TASK-34: inventory load on join (optional — test stubs predate it). */
    Partial<Pick<Repository, 'getPlayerInventory'>> &
    /** TASK-37: deposit delta upsert on mine (optional — test stubs predate it). */
    Partial<Pick<Repository, 'upsertDeposit'>>;
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
  /** TASK-29: the system's seeded pad list, per planet (one pad each). */
  private readonly planetPads = new Map<string, PadInfo>();
  /**
   * TASK-25: the regime manager's view of this system's planets, with a
   * LAZY terrain heightAt (the TerrainContext for a planet is only touched
   * when the regime check actually samples its surface — space ships never
   * generate chunks).
   */
  private readonly regimePlanets: RegimePlanet[];
  private readonly playerConns = new Map<string, string>();
  private readonly playerEntities = new Map<string, SimEntity>();
  /** Dev-hook deposit ids stay unique per shard (addDepositForTesting). */
  private devDepositSeq = 0;
  /** TASK-34: ground item ids stay unique per shard (handleDrop). */
  private groundItemSeq = 0;
  /** TASK-34: ground item ttl in TICKS (300 s at the shard's dt). */
  private readonly groundItemTtlTicks: number;
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
    this.groundItemTtlTicks = Math.max(
      1,
      Math.round(GROUND_ITEM_TTL_MS / (options.dtMs ?? TICK_DT_MS)),
    );
    this.persist = options.persist ?? (() => {});
    // TASK-29: derive the system's seeded pads once (cached per system) and
    // index them by planet — the pad list is system-derived data.
    for (const pad of padsForSystem(options.galaxySeed, options.system)) {
      this.planetPads.set(pad.planetId, pad);
    }
    // TASK-37: derive the system's seeded deposits (same pure function the
    // client uses — positions are NEVER stored, only the DB deltas) and
    // spawn them as static interactable entities. A restarted shard gets
    // the same entities, then loadShips overlays the persisted deltas
    // (remaining / discovered / despawned-at-zero).
    for (const deposit of depositsFor(options.galaxySeed, options.system)) {
      this.spawnDepositEntity(deposit);
    }
    this.regimePlanets = systemRegimePlanets(options.system).map((planet) => ({
      ...planet,
      heightAt: (x, z) => {
        const ctx = this.getTerrain(planet.id);
        ctx.update(x, z);
        // The pad disc is flat for the regime machine too (surface band).
        return padSurfaceHeight(x, z, ctx.heightAt(x, z), this.planetPads.get(planet.id));
      },
    }));

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
    // TASK-32: a disembarked player's frames are NOT dropped — the same
    // 'input' message drives their CHARACTER (the tick routes the frame to
    // integrateCharacter; the frozen ship loop skips the entity, so a frame
    // is never applied twice). Re-entry (TASK-35) restores ship control.
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
      // TASK-34: load the persisted inventory (survives reconnect + server
      // restart; an empty/corrupt row simply starts empty).
      entity.inventory = sanitizeInventory((await this.repo.getPlayerInventory?.(playerId)) ?? {});
      this.entities.set(entity.id, entity);
      this.playerEntities.set(playerId, entity);
    }
    // TASK-17: re-adopting the ship of a reconnecting player (the entity
    // already exists, still at its idle position) un-idles it. A headless
    // adopt (no connection) stays idle.
    entity.idle = !this.playerConns.has(playerId);
    // TASK-31: a disconnect while disembarked leaves the character in the
    // sim (TASK-24 pattern — it simply persists). A re-join re-adopts into
    // the SAME on-foot state: the ship stays frozen where it docked.
    if (this.entities.has(`char:${playerId}`)) entity.disembarked = true;
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
  registerConnection(
    playerId: string,
    callsign: string,
    send: ConnState['send'],
    source?: unknown,
  ): string {
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
        // TASK-32: a disconnect while on foot also releases the character's
        // held frame — it coasts to a stop (friction) instead of walking
        // forever (the ship itself is frozen and holds no input).
        if (entity.disembarked) {
          const character = this.entities.get(`char:${state.playerId}`);
          if (character) character.heldInput = undefined;
        }
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
   * TASK-8: full removal — the player's connection AND their ship entity
   * leave the shard. Warp departure: the ship now belongs to the target
   * system (its row's position.systemId moves with it), so no idle ghost
   * may remain in the source shard. A plain disconnect never uses this
   * (leavePlayer keeps the entity simulating, TASK-17).
   */
  removePlayer(playerId: string): void {
    const connId = this.playerConns.get(playerId);
    if (connId) this.unregisterConnection(connId);
    const entity = this.playerEntities.get(playerId);
    if (entity) {
      this.entities.delete(entity.id);
      this.playerEntities.delete(playerId);
    }
    this.log.debug('player fully removed (warp departure)', { playerId });
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

  /**
   * Protocol snapshot of all entities (10 Hz broadcast payload, joined form).
   * TASK-37: SEED-derived deposits are streamed by distance — only deposits
   * within DEPOSIT_RENDER_RANGE_M (500 m) of any player ride the snapshot
   * (120 static entities per system would otherwise bloat every frame;
   * the client derives the full list from the same seed and just applies
   * the quantity/discovered deltas). Dev-hook deposits (no depositSeq)
   * always ride (the e2e hooks place them anywhere).
   */
  snapshot(): EntityState[] {
    const out: EntityState[] = [];
    let playerPos: Vec3[] | undefined;
    for (const entity of this.entities.values()) {
      if (entity.kind === 'deposit' && entity.depositSeq !== undefined) {
        if (!playerPos) playerPos = this.playerPositions();
        const near = playerPos.some(
          (p) => vecLength(vecSub(entity.ship.pos, p)) <= DEPOSIT_RENDER_RANGE_M,
        );
        if (!near) continue;
      }
      out.push(entityToState(entity));
    }
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
      // TASK-31: the owner is on foot — the ship stays FROZEN where it docked
      // (no integration, no pad re-check: it keeps its docked state) until
      // the player re-enters it (TASK-35).
      if (entity.disembarked) continue;
      const connId = entity.playerId ? this.playerConns.get(entity.playerId) : undefined;
      const conn = connId ? this.connections.get(connId) : undefined;
      const input = conn?.input;
      if (conn && input) {
        conn.input = undefined; // consumed: becomes the held frame
        entity.heldInput = input; // held until a newer frame replaces it
        conn.appliedSeq = input.seq; // TASK-14: reconcilable from this tick on
        if (entity.docked) entity.docked = false; // first input = take-off
      }
      // TASK-25: resolve the regime FIRST (the shared state machine is the
      // authority — hysteresis included); a change is an event, and the new
      // regime drives the physics context for THIS tick.
      this.resolveRegime(entity);
      const ctx = this.resolveRegimeCtx(entity);
      const shipInput = inputToShipInput(entity.heldInput ?? ZERO_INPUT);
      entity.ship = integrateShip(
        entity.ship,
        shipInput,
        this.dt,
        entity.ship.regime,
        ctx.planet,
        shipStats(entity.classId),
        ctx.options,
      );
      // TASK-29: landing-pad state machine + VTOL drift assist (both run on
      // the integrated state, so takeoff clears 'docked' within one tick).
      this.updatePadState(entity, shipInput.up);
    }

    // TASK-32: integrate the on-foot characters (one per disembarked
    // player). SAME input frames as ships — the owner's active entity kind
    // decides the integrator (the ship loop skips disembarked ships, so the
    // frame is consumed here exactly once). The held-frame pattern mirrors
    // the ships: latest frame wins, re-integrated every tick until replaced,
    // cleared when the owner disconnects (unregisterConnection) so a
    // dropped character coasts to a stop instead of walking forever.
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'character' || !entity.playerId) continue;
      const connId = this.playerConns.get(entity.playerId);
      const conn = connId ? this.connections.get(connId) : undefined;
      if (conn) {
        const input = conn.input;
        if (input) {
          conn.input = undefined; // consumed: becomes the held frame
          entity.heldInput = input;
          conn.appliedSeq = input.seq; // TASK-14: reconcilable from this tick on
        }
      }
      const ctx = this.resolveRegimeCtx(entity);
      const charState: CharacterState = {
        pos: entity.ship.pos,
        vel: entity.ship.vel,
        quat: entity.ship.quat,
        onGround: entity.charOnGround ?? true,
      };
      const next = integrateCharacter(
        charState,
        inputToCharacterInput(entity.heldInput ?? ZERO_INPUT),
        this.dt,
        ctx.options.heightAt,
      );
      // The character's kinematic state rides the SAME ship-shaped record
      // (the wire snapshot reads entity.ship — no protocol change).
      entity.ship.pos = next.pos;
      entity.ship.vel = next.vel;
      entity.ship.quat = next.quat;
      entity.ship.regime = 'surface';
      entity.charOnGround = next.onGround;
      // TASK-34: the character carries the owner's inventory to the wire
      // (the client's weight bar reads the SELF entity — on foot that is
      // the character — so it mirrors the ship's stacks every tick).
      this.syncCharacterInventory(entity.playerId);
    }

    // TASK-37: deposit discovery (any player within 50 m flips the flag).
    this.sweepDiscovery();

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
   * TASK-25: resolve (and, on change, commit) an entity's regime with the
   * shared state machine BEFORE integration. The resolved regime is
   * authoritative: it is stored on the entity, emitted as a 'regime-change'
   * event, and rides the wire in every entity_update (`flightRegime`).
   * Hysteresis lives in regimeFor — a boundary-idling ship cannot flap.
   */
  private resolveRegime(entity: SimEntity): void {
    const result = regimeFor(
      entity.ship.pos,
      this.regimePlanets,
      entity.ship.regime,
      vecLength(entity.ship.vel),
    );
    if (result.regime === entity.ship.regime && result.planetId === entity.planetId) return;
    const from = entity.ship.regime;
    entity.ship.regime = result.regime;
    entity.planetId = result.planetId;
    this.log.debug('regime change', {
      entity: entity.id,
      from,
      to: result.regime,
      planetId: result.planetId ?? null,
    });
    this.events.emit('regime-change', {
      id: entity.id,
      playerId: entity.playerId,
      from,
      to: result.regime,
      planetId: result.planetId,
    });
  }

  /**
   * TASK-29: per-ship landing-pad state, evaluated AFTER integration so a
   * takeoff (vertical speed > 2 u/s) clears 'docked' within one tick.
   *
   * - The ship's own planet has at most one seeded pad; tracking uses the
   *   20 m acquisition / 25 m release hysteresis (resolvePadTarget), so a
   *   slow ship idling on the boundary cannot flap.
   * - 'docked' = tracking the pad AND satisfying the dock condition
   *   (surface regime, |vel.y| < 2 u/s, altitude within 1 m of the pad
   *   height). The state is a SINGLE padId — a ship can never be docked at
   *   two pads (asserted in the sim tests). Docked ships keep simulating:
   *   no input lock, the player can take off at any time.
   * - VTOL assist (server-side physics): with the VTOL key held, within
   *   100 m of the pad and below 50 u/s, horizontal drift is damped ×0.5
   *   every tick — what makes parking possible.
   *
   * The change rides the wire in the next 10 Hz entity_update
   * (regime 'docked' + padId); 'pad-dock'/'pad-undock' events are emitted
   * for observability (tests, future HUD toasts).
   */
  private updatePadState(entity: SimEntity, up: number): void {
    const pad = entity.planetId ? this.planetPads.get(entity.planetId) : undefined;
    if (!pad) {
      if (entity.padId) {
        entity.padId = undefined;
        this.events.emit('pad-undock', { id: entity.id, playerId: entity.playerId });
      }
      return;
    }
    const target = resolvePadTarget(entity.ship.pos, [pad], entity.padId);
    const wasDocked = entity.padId === pad.padId;
    // Distance is owned by resolvePadTarget (20 m acquire / 25 m release
    // hysteresis), so a docked ship idling on the 20–25 m boundary KEEPS its
    // pad instead of flapping — only a takeoff (|vel.y| ≥ 2) or leaving the
    // surface regime releases it. A FRESH dock still requires the full
    // condition (on the ≤ 20 m disc, surface, slow, at pad height).
    const docked = wasDocked
      ? target !== undefined &&
        entity.ship.regime === 'surface' &&
        Math.abs(entity.ship.vel.y) < DOCK_VERTICAL_SPEED_MAX_M_S
      : target !== undefined &&
        satisfiesDock(entity.ship.pos, entity.ship.vel, entity.ship.regime, target);
    if (docked) {
      if (entity.padId !== pad.padId) {
        entity.padId = pad.padId;
        this.log.debug('pad dock', { entity: entity.id, padId: pad.padId });
        this.events.emit('pad-dock', {
          id: entity.id,
          playerId: entity.playerId,
          padId: pad.padId,
        });
      }
    } else if (entity.padId) {
      entity.padId = undefined;
      this.log.debug('pad undock', { entity: entity.id });
      this.events.emit('pad-undock', { id: entity.id, playerId: entity.playerId });
    }
    if (up > 0 && vtolAssistActive(up, vecLength(entity.ship.vel), entity.ship.pos, [pad])) {
      entity.ship.vel = applyVtolAssist(entity.ship.vel);
    }
  }

  /**
   * Dev/test hook (TASK-33 e2e): place a deposit at an exact position in the
   * shard (the seeded deposit PLACEMENT lands in TASK-37 — until then the
   * e2e and the interaction tests need an interactable to stand in front of).
   * Returns the new entity id (`deposit:dev<n>`).
   */
  addDepositForTesting(pos: Vec3, quantity = 1): string {
    const id = `deposit:dev${++this.devDepositSeq}`;
    this.entities.set(id, {
      id,
      kind: 'deposit',
      playerId: null,
      classId: 'deposit',
      // Static world object: zero velocity, identity facing, surface regime.
      ship: {
        pos: { ...pos },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      quantity,
    });
    this.log.debug('deposit placed (dev/test hook)', { deposit: id, pos });
    return id;
  }

  /**
   * TASK-37: spawn the static entity for one SEED-derived deposit. Id is
   * `deposit:<depositId>` where depositId = `${systemId}:${depositSeq}` —
   * the stable seed-derived key the DB delta row maps back to.
   */
  private spawnDepositEntity(deposit: Deposit): void {
    this.entities.set(`deposit:${deposit.depositId}`, {
      id: `deposit:${deposit.depositId}`,
      kind: 'deposit',
      playerId: null,
      classId: 'deposit',
      ship: {
        pos: { ...deposit.pos },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      quantity: deposit.amount,
      resourceId: deposit.resourceId,
      depositSeq: deposit.depositSeq,
      depositDiscovered: deposit.discovered,
      planetId: deposit.planetId,
    });
  }

  /**
   * TASK-37: the player positions a discovery/streaming check runs against
   * — every player's ACTIVE entity (the on-foot character when disembarked,
   * else the ship — including idle ships of disconnected players).
   */
  private playerPositions(): Vec3[] {
    const out: Vec3[] = [];
    for (const entity of this.playerEntities.values()) {
      if (entity.disembarked) continue; // the character below carries them
      out.push(entity.ship.pos);
    }
    for (const entity of this.entities.values()) {
      if (entity.kind === 'character') out.push(entity.ship.pos);
    }
    return out;
  }

  /**
   * TASK-37: the discovery sweep — a deposit flips `depositDiscovered`
   * (server-side, persisted with the next mine) when ANY player's active
   * entity comes within DEPOSIT_DISCOVERY_RADIUS_M. Runs every tick over
   * UNDISCOVERED deposits only (bounded, 3D distance — a ship skimming the
   * surface at 50 m also discovers).
   */
  private sweepDiscovery(): void {
    const positions = this.playerPositions();
    if (positions.length === 0) return;
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'deposit' || entity.depositDiscovered) continue;
      const near = positions.some(
        (p) =>
          vecLength(vecSub(entity.ship.pos, p)) <= DEPOSIT_DISCOVERY_RADIUS_M,
      );
      if (near) {
        entity.depositDiscovered = true;
        this.log.info('deposit discovered', { deposit: entity.id, depositSeq: entity.depositSeq });
        this.events.emit('deposit-discovered', {
          id: entity.id,
          depositSeq: entity.depositSeq,
        });
      }
    }
  }

  /**
   * TASK-37: persist a seeded deposit's delta row. The row is created
   * LAZILY on first mine (upsert with the remaining amount + discovered);
   * later mines are full-state upserts of the same row (the shard is the
   * single writer for a system's deposits, so a one-row upsert is the
   * atomic decrement; the repo also offers an UPDATE-with-guard variant).
   * Depleted deposits keep their row (remaining 0) — the entity despawns.
   * Failures log and never throw (a DB blip must not kill the sim).
   */
  private persistDeposit(entity: SimEntity): void {
    if (entity.depositSeq === undefined) return; // dev-hook deposit: no row
    const upsert = this.repo.upsertDeposit;
    if (!upsert) return; // test stub without the method: in-memory only
    const row: DepositRow = {
      systemId: this.systemId,
      depositSeq: entity.depositSeq,
      depositId: `${this.systemId}:${entity.depositSeq}`,
      planetId: entity.planetId ?? '',
      pos: { ...entity.ship.pos },
      resourceId: entity.resourceId ?? '',
      remaining: entity.quantity ?? 0,
      discovered: entity.depositDiscovered ?? false,
    };
    void upsert.call(this.repo, row).catch((err: unknown) => {
      this.log.warn('deposit persist failed', {
        deposit: entity.id,
        error: String(err),
      });
    });
  }

  /**
   * Dev/test hook (TASK-29 e2e teleport-assist): hard-set a player ship's
   * position + velocity. The regime machine re-resolves from the new
   * position on the next tick; held input is cleared (no ghost thrust).
   * Returns false for unknown/destroyed ships.
   */
  teleportForTesting(playerId: string, pos: Vec3, vel?: Vec3): boolean {
    const entity = this.playerEntities.get(playerId);
    if (!entity || entity.destroyed) return false;
    entity.ship.pos = { ...pos };
    entity.ship.vel = vel ? { ...vel } : { x: 0, y: 0, z: 0 };
    entity.heldInput = undefined;
    entity.idle = false;
    this.log.debug('teleport (dev/test hook)', { playerId, x: pos.x, y: pos.y, z: pos.z });
    return true;
  }

  /**
   * TASK-31: disembark — the player (authenticated + joined, guaranteed by
   * the WS layer) exits their PAD-DOCKED ship: the sim spawns a static
   * character entity (id `char:<playerId>`) 2.5 m to the ship's side on the
   * pad plane (shared characterSpawnPos math), the ship stays docked and
   * frozen (tick skips it, its inputs are dropped), and the character rides
   * the next 10 Hz entity_update to every peer (one shared buffer — all
   * clients see the same spawn). A denial answers the requesting connection
   * with a structured error ('not-docked' per the TASK-31 contract).
   *
   * The character lives in `entities` but NOT `playerEntities`: it owns no
   * ship-input lane (walking input arrives in TASK-32), and a disconnect
   * while on foot leaves it in the sim exactly like a ship (TASK-24).
   */
  handleExitShip(playerId: string, shipId: string, source?: unknown): ExitShipOutcome {
    const entity = this.entities.get(shipId);
    if (!entity || entity.kind !== 'ship' || entity.playerId !== playerId) {
      this.sendErrorToPlayer(playerId, 'unknown-ship', 'not your ship', source);
      return 'unknown-ship';
    }
    if (entity.disembarked) {
      this.log.debug('exit ignored: already on foot', { playerId, shipId });
      return 'already-on-foot';
    }
    if (!entity.padId) {
      this.sendErrorToPlayer(playerId, 'not-docked', 'ship is not docked on a landing pad', source);
      return 'not-docked';
    }
    const pad = [...this.planetPads.values()].find((p) => p.padId === entity.padId);
    const pos = characterSpawnPos(
      entity.ship.pos,
      entity.ship.quat,
      pad ? pad.pos.y : entity.ship.pos.y,
    );
    this.entities.set(`char:${playerId}`, {
      id: `char:${playerId}`,
      kind: 'character',
      playerId,
      callsign: entity.callsign,
      classId: entity.classId,
      // Standing on the pad plane: surface regime, zero velocity, identity
      // facing, grounded (TASK-32 walks it from here).
      ship: { pos, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'surface' },
      hull: entity.hull,
      shields: entity.shields,
      targetId: null,
      docked: false,
      // The character inherits the ship's planet (terrain context for the
      // walk) and its livery (the client colors the character from it).
      planetId: entity.planetId,
      charOnGround: true,
      ...(entity.livery ? { livery: entity.livery } : {}),
    });
    entity.disembarked = true;
    this.log.info('player disembarked', {
      playerId,
      ship: shipId,
      character: `char:${playerId}`,
      pos,
    });
    this.events.emit('disembarked', {
      playerId,
      shipId,
      characterId: `char:${playerId}`,
      pos,
    });
    return 'ok';
  }

  /**
   * TASK-35: re-entry — the reverse of handleExitShip. The on-foot player
   * (authenticated + joined, guaranteed by the WS layer) re-claims their
   * own ship: the CHARACTER entity is removed, the ship is unfrozen
   * (disembarked cleared, held frame dropped so no ghost thrust), and the
   * player's active entity switches character → ship. The whole world sees
   * it in the next 10 Hz entity_update (one shared buffer — the character
   * simply leaves every client's snapshot; no orphan state survives).
   *
   * Validation order (each failure answers the REQUESTING connection with a
   * structured error, stale-conn guarded, like handleExitShip):
   * 1. the ship entity must exist in the shard → {code:'not-found'};
   * 2. ownership — ONLY the ship's owner can board it in v1 (no boarding
   *    others' ships) → {code:'not-owner'};
   * 3. idempotency — the player must be on foot (a `char:<playerId>`
   *    exists). A double enter_ship (e.g. racing a reconnect) is
   *    {code:'already-in-ship'} — the switch is a no-op, no duplicate state;
   * 4. range — within 5 m of the ship's position (ENTER_SHIP_RANGE_M, the
   *    per-kind reach shared with the client prompt) → {code:'out-of-range'};
   * 5. speed — the ship must be IDLE (velocity < 1 u/s,
   *    ENTER_SHIP_MAX_SPEED). Being off-pad is fine (a drifting ship at
   *    rest can be re-claimed); a moving ship is {code:'ship-moving'}.
   */
  handleEnterShip(playerId: string, shipId: string, source?: unknown): EnterShipOutcome {
    const entity = this.entities.get(shipId);
    if (!entity || entity.kind !== 'ship') {
      this.sendErrorToPlayer(playerId, 'not-found', `unknown ship ${shipId}`, source);
      return 'unknown-ship';
    }
    if (entity.playerId !== playerId) {
      this.sendErrorToPlayer(playerId, 'not-owner', 'that ship belongs to another pilot', source);
      return 'not-owner';
    }
    const character = this.entities.get(`char:${playerId}`);
    if (!character) {
      // Already in the ship (or never disembarked) — the switch is a no-op.
      // This is the idempotency guard: a double enter_ship (stale character
      // racing a reconnect) changes nothing and gets a structured error.
      this.log.debug('enter ignored: already in ship', { playerId, shipId });
      this.sendErrorToPlayer(playerId, 'already-in-ship', 'you are already in this ship', source);
      return 'already-in-ship';
    }
    if (vecLength(vecSub(entity.ship.pos, character.ship.pos)) > ENTER_SHIP_RANGE_M) {
      this.sendErrorToPlayer(playerId, 'out-of-range', 'the ship is out of reach', source);
      return 'out-of-range';
    }
    if (vecLength(entity.ship.vel) >= ENTER_SHIP_MAX_SPEED) {
      this.sendErrorToPlayer(
        playerId,
        'ship-moving',
        'the ship is moving — too fast to board',
        source,
      );
      return 'ship-moving';
    }
    this.entities.delete(character.id);
    entity.disembarked = false;
    entity.heldInput = undefined; // no ghost thrust on re-entry
    entity.idle = false; // the owner is here again (covers reconnect races)
    this.log.info('player re-entered ship', {
      playerId,
      ship: shipId,
      removed: character.id,
      pos: entity.ship.pos,
    });
    this.events.emit('entered-ship', {
      playerId,
      shipId,
      removedCharacterId: character.id,
    });
    return 'ok';
  }

  /**
   * TASK-33: an on-foot player interacts with the target in front of them.
   * Validation order — each failure answers the REQUESTING connection with a
   * structured error (stale-conn guarded, like handleExitShip):
   * 1. regime — the player must be ON FOOT (a `char:<playerId>` entity
   *    exists); still in the ship → {code:'wrong-regime'};
   * 2. target — must exist in the shard AND be an interactable kind
   *    (deposit / ship / terminal); unknown id or non-interactable kind →
   *    {code:'not-found'};
   * 3. range — within the PER-KIND reach (3 m default, the ship's 5 m enter
   *    radius — TASK-35) of the player's CHARACTER position (server-side) →
   *    else {code:'out-of-range'}.
   * Then dispatch BY KIND — the server-side counterpart of the client's
   * InteractableRegistry, one branch per kind (no scattered if-chains):
   * - 'deposit'  → the v1 pickup (one unit; despawn at zero). This is the
   *                delegate point TASK-38 replaces with the 1.5 s channel;
   * - 'terminal' → a 'ui-open' {ui:'dock'} frame to the requester (the dock
   *                UI that consumes it lands in TASK-40/53);
   * - 'ship'     → delegates to handleEnterShip (TASK-35) — the same effect
   *                 and validation as the dedicated 'enter_ship' message, so
   *                 a legacy interact frame and the new one can never diverge.
   * Like handleExitShip the handler mutates the entity directly; the next
   * 10 Hz entity_update carries the effect to EVERY peer (one shared buffer,
   * so all clients see a pickup within one snapshot).
   */
  handleInteract(
    playerId: string,
    targetId: string,
    action?: string,
    source?: unknown,
  ): InteractOutcome {
    const character = this.entities.get(`char:${playerId}`);
    if (!character) {
      this.sendErrorToPlayer(
        playerId,
        'wrong-regime',
        'interactions require being on foot',
        source,
      );
      return 'wrong-regime';
    }
    const target = this.entities.get(targetId);
    if (!target || !isInteractableKind(target.kind)) {
      this.sendErrorToPlayer(playerId, 'not-found', `unknown interactable ${targetId}`, source);
      return 'not-found';
    }
    // Per-kind reach (TASK-35): ships get the 5 m enter radius, the rest
    // 3 m — the SAME number the client prompt raycasts with.
    if (vecLength(vecSub(target.ship.pos, character.ship.pos)) > interactRangeFor(target.kind)) {
      this.sendErrorToPlayer(playerId, 'out-of-range', 'the target is out of reach', source);
      return 'out-of-range';
    }
    switch (target.kind) {
      case 'groundItem':
        // TASK-34: partial pickup into the weight-capped inventory (the
        // same interact/prompt flow as deposits — 'Take iron x3'). The
        // {taken, remaining} result rides the 'pickup' event + logs.
        this.handlePickup(playerId, target, source);
        return 'ok';
      case 'deposit':
        return this.applyPickup(playerId, target, action);
      case 'terminal':
        this.sendUiOpen(playerId, target.id, source);
        return 'ok';
      case 'ship':
        // TASK-35: re-entry — delegate to the dedicated handler (ownership,
        // 5 m range, speed cap, idempotency). Same effect as the 'enter_ship'
        // message; one handler owns the state change.
        return this.handleEnterShip(playerId, targetId, source);
    }
  }

  /**
   * The v1 pickup effect (delegate point for TASK-38's 1.5 s mining
   * channel): one unit leaves the deposit; at zero remaining the deposit
   * despawns for everyone (it simply leaves the next 10 Hz snapshot).
   */
  private applyPickup(
    playerId: string,
    target: SimEntity,
    action: string | undefined,
  ): InteractOutcome {
    const remaining = Math.max(0, (target.quantity ?? 1) - 1);
    const depleted = remaining === 0;
    if (depleted) {
      // TASK-37: a depleted SEED deposit despawns (entity removed) but its
      // DB row stays with remaining 0 — the mine is what persists it.
      if (target.depositSeq !== undefined) {
        target.quantity = 0;
        target.depositDiscovered = true;
        this.persistDeposit(target);
        this.entities.delete(target.id);
      } else {
        this.entities.delete(target.id);
      }
    } else {
      target.quantity = remaining;
      // TASK-37: seed deposits persist on every mine (row created lazily on
      // the FIRST mine; upsert after). Dev-hook deposits stay in-memory.
      if (target.depositSeq !== undefined) {
        target.depositDiscovered = true; // a mine happened at < 3 m
        this.persistDeposit(target);
      }
    }
    this.log.info('deposit picked up', {
      playerId,
      deposit: target.id,
      remaining,
      ...(action !== undefined ? { action } : {}),
    });
    this.events.emit('pickup', {
      playerId,
      targetId: target.id,
      remaining,
      depleted,
    });
    return 'ok';
  }

  /**
   * TASK-34: the player's inventory stacks (one per player, kept on the
   * PLAYER's ship entity — shared across ship and on-foot). Undefined until
   * the first pickup / loaded row; treated as empty otherwise.
   */
  getInventory(playerId: string): InventoryStacks {
    const entity = this.playerEntities.get(playerId);
    return entity?.inventory ?? emptyInventory();
  }

  /**
   * TASK-34: mirror the owner's stacks onto the on-foot CHARACTER entity.
   * The client's weight bar reads the SELF entity — on foot the self entity
   * IS the character — so it must carry the same inventory as the ship
   * (stacks objects are replaced, never mutated, so sharing the reference is
   * safe as long as this runs after every inventory change).
   */
  private syncCharacterInventory(playerId: string): void {
    const character = this.entities.get(`char:${playerId}`);
    if (!character) return;
    character.inventory = this.playerEntities.get(playerId)?.inventory;
  }

  /**
   * TASK-34: partial pickup of a GROUND ITEM into the weight-capped
   * inventory (the TASK-38 contract defined early — mining reuses it):
   * validation mirrors handleInteract (on foot → known ground item → 3 m
   * range), then the shared pickupInto math — takes what FITS, leaves the
   * remainder on the ground item (despawn at zero). Returns
   * {taken, remaining}. All state rides the next 10 Hz entity_update
   * (quantity change + the taker's inventory) to every peer.
   */
  handlePickup(
    playerId: string,
    target: SimEntity,
    source?: unknown,
  ): { taken: number; remaining: number } {
    const character = this.entities.get(`char:${playerId}`);
    if (!character) {
      this.sendErrorToPlayer(playerId, 'wrong-regime', 'pickups require being on foot', source);
      return { taken: 0, remaining: target.quantity ?? 0 };
    }
    if (target.kind !== 'groundItem' || !target.resourceId) {
      this.sendErrorToPlayer(playerId, 'not-found', 'unknown ground item', source);
      return { taken: 0, remaining: target.quantity ?? 0 };
    }
    if (vecLength(vecSub(target.ship.pos, character.ship.pos)) > INTERACT_RANGE_M) {
      this.sendErrorToPlayer(playerId, 'out-of-range', 'the ground item is out of reach', source);
      return { taken: 0, remaining: target.quantity ?? 0 };
    }
    if (!isResourceId(target.resourceId)) {
      this.log.warn('dropped ground item with unknown resource', {
        target: target.id,
        resource: target.resourceId,
      });
      return { taken: 0, remaining: target.quantity ?? 0 };
    }
    const available = target.quantity ?? 0;
    const player = this.playerEntities.get(playerId);
    const res = pickupInto(player?.inventory ?? emptyInventory(), target.resourceId, available);
    if (res.taken === 0) {
      this.sendErrorToPlayer(playerId, 'inventory-full', 'not enough weight capacity', source);
      return res;
    }
    if (player) {
      player.inventory = res.stacks;
      this.syncCharacterInventory(playerId);
    }
    const left = available - res.taken;
    if (left <= 0) this.entities.delete(target.id);
    else target.quantity = left;
    this.log.info('ground item picked up', {
      playerId,
      item: target.id,
      resource: target.resourceId,
      taken: res.taken,
      left,
    });
    this.events.emit('pickup', {
      playerId,
      targetId: target.id,
      resource: target.resourceId,
      taken: res.taken,
      remaining: left,
      depleted: left <= 0,
    });
    return { taken: res.taken, remaining: left };
  }

  /**
   * TASK-34: drop `amount` units of `resourceId` at the player's position.
   * Validation (each failure → structured error to the requesting conn,
   * stale-conn guarded): known resource, on foot (drops happen AT the
   * character's location), amount ≤ owned. Success removes from the stacks
   * (shared dropFrom math) and spawns a 'groundItem' entity — interactable
   * ('Take' prompt), 300 s ttl (generic tick ttl sweep), in every snapshot
   * (visible to all players).
   */
  handleDrop(
    playerId: string,
    resourceId: string,
    amount: number,
    source?: unknown,
  ): 'ok' | 'invalid-resource' | 'invalid-amount' | 'not-owned' | 'wrong-regime' {
    const character = this.entities.get(`char:${playerId}`);
    if (!character) {
      this.sendErrorToPlayer(playerId, 'wrong-regime', 'drops require being on foot', source);
      return 'wrong-regime';
    }
    if (!isResourceId(resourceId)) {
      this.sendErrorToPlayer(
        playerId,
        'invalid-resource',
        `unknown resource ${resourceId}`,
        source,
      );
      return 'invalid-resource';
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      this.sendErrorToPlayer(
        playerId,
        'invalid-amount',
        'amount must be a positive integer',
        source,
      );
      return 'invalid-amount';
    }
    const player = this.playerEntities.get(playerId);
    const stacks = player?.inventory ?? emptyInventory();
    const owned = stacks[resourceId] ?? 0;
    if (amount > owned) {
      this.sendErrorToPlayer(playerId, 'not-owned', `you only have ${owned} ${resourceId}`, source);
      return 'not-owned';
    }
    const res = dropFrom(stacks, resourceId, amount);
    if (player) {
      player.inventory = res.stacks;
      this.syncCharacterInventory(playerId);
    }
    const id = `groundItem:${++this.groundItemSeq}`;
    this.entities.set(id, {
      id,
      kind: 'groundItem',
      playerId: null,
      classId: 'groundItem',
      ship: {
        pos: { ...character.ship.pos },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      quantity: res.dropped,
      resourceId,
      ttl: this.groundItemTtlTicks,
    });
    this.log.info('items dropped', { playerId, item: id, resourceId, amount: res.dropped });
    this.events.emit('drop', {
      playerId,
      targetId: id,
      resource: resourceId,
      amount: res.dropped,
    });
    return 'ok';
  }

  /**
   * Dev/test hook (TASK-34 e2e): grant inventory units directly (the real
   * earn path is pickup/mining — TASK-38). Merges into the existing stacks.
   */
  giveInventoryForTesting(playerId: string, stacks: Partial<Record<ResourceId, number>>): void {
    const player = this.playerEntities.get(playerId);
    if (!player) return;
    const next = { ...(player.inventory ?? emptyInventory()) };
    for (const [id, amount] of Object.entries(stacks)) {
      if (isResourceId(id) && Number.isInteger(amount) && amount > 0) {
        next[id] = (next[id] ?? 0) + amount;
      }
    }
    player.inventory = next;
    this.syncCharacterInventory(playerId);
  }

  /**
   * TASK-33: the 'ui-open' frame — server → the requesting connection ONLY
   * (the panel is a per-player view): {ui:'dock', payload:{terminalId}}.
   * Validated against the wire contract before it goes out (a failing frame
   * must never crash the dispatch, mirroring the snapshot path).
   */
  private sendUiOpen(playerId: string, terminalId: string, source?: unknown): void {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return;
    if (source !== undefined && conn.source !== source) return;
    const payload = {
      ui: 'dock',
      payload: { terminalId },
    } satisfies PayloadSchemas['ui-open'];
    const check = messageSchemas['ui-open'].safeParse(payload);
    if (!check.success) {
      this.log.warn('ui-open failed wire validation', {
        issue: check.error.issues[0]?.message,
      });
      return;
    }
    conn.send(encodeMessage('ui-open', check.data));
  }

  /** Structured error to one player's CURRENT connection (stale-conn guarded). */
  private sendErrorToPlayer(
    playerId: string,
    code: string,
    message: string,
    source?: unknown,
  ): void {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return;
    if (source !== undefined && conn.source !== source) return;
    conn.send(encodeMessage('error', { code, message }));
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
      planet: planet.hasAtmosphere
        ? {
            atmosphereDensity: planetAtmosphereDensity(planet),
            atmosphereRadius: planetAtmosphereRadius(planet),
          }
        : undefined,
      options: {
        // TASK-29: the pad disc is flat for physics too (the ship rests at
        // the pad height anywhere on the 40 m circle — the arcade landing).
        heightAt: (x, z) =>
          padSurfaceHeight(x, z, ctx.heightAt(x, z), this.planetPads.get(planet.id)),
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
    // TASK-29: a docked ship with a pad id is PAD-docked (resting on a
    // landing pad) — it keeps its saved position; only a plain docked ship
    // loads at the system dock (the row's position is the home-system dock
    // of a possibly different system; this system's dock is the canonical
    // resting spot, seed-derived like everything else).
    const padDocked = docked && !!ship.onPad;
    const dock = homeDockPosition(this.galaxySeed, this.systemId);
    const pos =
      docked && !padDocked
        ? { x: dock.x, y: dock.y, z: dock.z }
        : { x: ship.position.x, y: ship.position.y, z: ship.position.z };
    const quat = isQuat(ship.rotation) ? { ...ship.rotation } : quatIdentity();
    // TASK-25: 'surface' is a first-class persisted regime; anything else
    // (foreign/corrupt rows) falls back to space.
    const regime: SimEntity['ship']['regime'] = validRegime(ship.regime) ? ship.regime : 'space';
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
      // TASK-29: pad-docked ships come back docked on their pad (the tick
      // re-validates the dock condition, so a corrupt row self-heals).
      ...(padDocked && ship.onPad ? { padId: ship.onPad } : {}),
      destroyed: ship.state === 'destroyed',
      destroyedAtMs: ship.destroyedAt ? Date.parse(ship.destroyedAt) : undefined,
    };
  }

  /**
   * TASK-37: overlay the persisted deposit DELTAS onto the seeded entities
   * (the seed is the source of truth for positions; the row wins for
   * remaining/discovered). A row with remaining 0 despawns the entity
   * (the row STAYS — re-mining a depleted deposit is impossible in v1).
   */
  private applyDepositDeltas(rows: DepositRow[]): number {
    let applied = 0;
    for (const row of rows) {
      const entity = this.entities.get(`deposit:${row.depositId}`);
      if (!entity) continue; // the derived list is the source of truth
      if (row.remaining <= 0) {
        this.entities.delete(entity.id);
        continue;
      }
      entity.quantity = row.remaining;
      entity.depositDiscovered = row.discovered;
      applied += 1;
    }
    return applied;
  }

  /**
   * TASK-24: shard-spawn load — rebuild the sim from the persisted ships of
   * this system (the result of ShardPersist.loadShips). Flying/on-foot ships
   * come back with their saved state; docked ships at dock coords; unexpired
   * destroyed ships as static wrecks with their remaining ttl. Entities that
   * are already in the shard are never clobbered.
   */
  async loadShips(load: ShipsLoad): Promise<{ ships: number; wrecks: number; depositDeltas: number }> {
    const owners = [...new Set(load.ships.map((r) => r.ownerId))];
    const playerRows = new Map((await this.repo.getPlayersByIds(owners)).map((p) => [p.id, p]));
    let ships = 0;
    for (const row of load.ships) {
      if (this.playerEntities.has(row.ownerId)) continue; // already in-shard
      const owner = playerRows.get(row.ownerId);
      const entity = this.entityFromShipRow(row, owner?.callsign);
      // TASK-34: restart rehydration includes the inventory (players.inventory —
      // the raw JSON row field, parsed + sanitized in one place).
      if (owner) entity.inventory = parseInventoryJson(owner.inventory);
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
          regime: validRegime(row.regime) ? row.regime : 'space',
        },
        hull: 0,
        shields: 0,
        targetId: null,
        docked: false,
        ttl: Math.max(1, Math.round(remainingMs / (this.dt * 1000))),
      });
      wrecks += 1;
    }
    // TASK-37: overlay the deposit deltas (remaining / discovered /
    // despawned-at-zero) onto the seeded entities — positions stay derived.
    const depositDeltas = this.applyDepositDeltas(load.deposits);
    this.log.info('shard loaded persisted state', {
      systemId: this.systemId,
      ships,
      wrecks,
      deletedExpired: load.deletedExpired,
      depositDeltas,
    });
    return { ships, wrecks, depositDeltas };
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

/** The outcome of a disembark request (TASK-31). */
export type ExitShipOutcome = 'ok' | 'not-docked' | 'unknown-ship' | 'already-on-foot';

/** The outcome of a re-entry request (TASK-35). */
export type EnterShipOutcome =
  'ok' | 'unknown-ship' | 'not-owner' | 'already-in-ship' | 'out-of-range' | 'ship-moving';

/**
 * The outcome of an interaction request (TASK-33) — the 'ship' branch
 * delegates to handleEnterShip, so the enter-ship codes are part of the
 * union (TASK-35).
 */
export type InteractOutcome =
  | 'ok'
  | 'not-found'
  | 'out-of-range'
  | 'wrong-regime'
  | Exclude<EnterShipOutcome, 'ok' | 'out-of-range'>;

/** Entity → wire EntityState (hull/shields normalized 0..1, regime mapped). */
export function entityToState(e: SimEntity): EntityState {
  // Wire regimes v1: docked (at a dock or settled on a pad) vs sublight flight.
  const regime: EntityState['regime'] = e.docked || e.ship.onPad || e.padId ? 'docked' : 'sublight';
  const state: EntityState = {
    id: e.id,
    kind: e.kind,
    pos: e.ship.pos,
    vel: e.ship.vel,
    rot: e.ship.quat, // TASK-14: reconciliation + remote slerp
    regime,
    // TASK-25: the regime manager's flight regime (authoritative).
    flightRegime: e.ship.regime,
    hull: e.hull,
    shields: e.shields,
    targetId: e.targetId,
    classId: e.classId,
  };
  if (e.callsign) state.callsign = e.callsign;
  if (e.livery) state.livery = e.livery;
  // TASK-29: the docked landing pad id (entity_update.state = 'docked' {padId}).
  if (e.padId) state.padId = e.padId;
  // TASK-33: deposit remaining units — a pickup shows as a quantity change,
  // or a removal at zero, in every client's next snapshot. TASK-34:
  // ground items ride the same field (their units) + `resourceId`.
  if (e.quantity !== undefined) state.quantity = e.quantity;
  if (e.resourceId !== undefined) state.resourceId = e.resourceId;
  // TASK-34: player-owned entities (ship + character) carry the inventory
  // so the client's weight bar updates within one snapshot of any change.
  if (e.kind === 'ship' || e.kind === 'character') {
    if (e.inventory !== undefined) state.inventory = toPlayerInventory(e.inventory);
  }
  // TASK-31: character entities carry their owner + the on-foot flag so
  // clients route the control target / camera off the same shape.
  if (e.kind === 'character') {
    state.playerId = e.playerId ?? undefined;
    state.onFoot = true;
  }
  return state;
}
