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
import {
  quatIdentity,
  quatRotateVector,
  vecAdd,
  vecDot,
  vecLength,
  vecScale,
  vecSub,
  type Quat,
  type Vec3,
} from '@shared/physics/vec';
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
  DEPOSIT_ENTITY_PREFIX,
  DEPOSIT_RENDER_RANGE_M,
  depositsFor,
  planetHeightSampler,
  type Deposit,
} from '@shared/world/deposits';
import {
  characterSpawnPos,
  integrateCharacter,
  ZERO_CHARACTER_INPUT,
  type CharacterState,
} from '@shared/physics/character';
import { TERMINAL_RANGE_M, terminalsFor, type TerminalInfo } from '@shared/world/terminals';
import {
  DRONE_AGGRO_RADIUS_M,
  DRONE_CHASE_SPEED,
  DRONE_FIRE_INTERVAL_MS,
  DRONE_FIRE_RADIUS_M,
  DRONE_HIT_DAMAGE,
  DRONE_HOVER_M,
  DRONE_HULL,
  DRONE_ORBIT_SPEED,
  DRONE_RESPAWN_MS,
  EXPOSURE_MAX,
  FULL_EXPOSURE,
  RECOVER_MS,
  hazardAt,
  hazardsFor,
  tickExposure,
  type DrainKind,
  type ExposureState,
  type Hazard,
} from '@shared/world/hazards';
import { ROGUE_RESPAWN_MS, rosterFor, type RogueRosterEntry } from '@shared/world/ai';
import { sellFrom, type SellErrorCode, type SellSource } from '@shared/sell';
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
import {
  emptyCargoHold,
  parseCargoJson,
  toCargoHold,
  transferCargo,
  type CargoHold,
} from '@shared/cargo';
import { MINING_UNIT_MS, stepMiningChannel, type MiningChannel } from '@shared/mining';
import { SHIP_CLASSES, shipStats, HEX_COLOR } from '@shared/ships';
import {
  coneContains,
  LOCK_CONE_RAD,
  LOCK_RANGE_M,
  LOCK_RELEASE_RANGE_M,
  LOCK_TTL_MS,
  MISSILE_CONE_RAD,
  MISSILE_CONE_RANGE_M,
  pickNearestInCone,
} from '@shared/targeting';
import {
  ENERGY_MAX,
  canFire,
  loadoutFor,
  regenEnergy,
  spendEnergy,
  stepMissile,
  WEAPON_BY_ID,
  type WeaponId,
  type WeaponSpec,
} from '@shared/weapons';
import type { Planet, SystemGen } from '@shared/galaxy/types';
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
import { lineOfSight, resolveHit, type ResolveHitOutcome } from './combat';
import {
  createAiState,
  makeWaypoints,
  resetAiState,
  stepAi,
  tickRng,
  type AiPlayerView,
  type AiState,
  type AiWorld,
} from './ai';
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

// --- TASK-43: weapons (the server is the ONLY authority; all re-derived) ---
/** Queued fire intents per conn, resolved in the tick (single writer). */
export const FIRE_QUEUE_MAX = 4;
/** Anti-spam: this many fire MESSAGES per 1 s window locks the weapons… */
export const FIRE_SPAM_LIMIT = 30;
/** …for this long ({code:'weapon-locked'} to the connection). */
export const WEAPON_LOCK_MS = 5_000;
/** Missile entity budget per shard (the oldest expires first when hit). */
export const PROJECTILE_CAP = 16;
/** Laser ray vs a ship: the perpendicular hit radius (m, ship half-size). */
export const LASER_HIT_RADIUS_M = 5;
/** The nose: the laser/missile origin offset along the ship's forward (m). */
export const NOSE_OFFSET_M = 3;

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
    Partial<Pick<Repository, 'upsertDeposit'>> &
    /**
     * TASK-40: the sell path's atomic commit (stack decrement + addCredits in
     * one transaction — optional, test stubs predate it).
     */
    Partial<
      Pick<
        Repository,
        | 'withTransaction'
        | 'addCredits'
        | 'updatePlayerInventory'
        | 'updateShipCargo'
        /** TASK-49: the destruction's respawn (cargo loss + starter scout row). */
        | 'respawnShip'
      >
    >;
  /** Keep in-shard entities in sync with dock purchases / livery changes. */
  shipSwapBus: ShipSwapBus;
  persist?: (entities: EntityState[]) => void;
  log?: ShardLogger;
  dtMs?: number;
  /** Injectable clock (tests use a fake now for destruction timestamps). */
  now?: () => number;
  /**
   * TASK-46: skip the seeded rogue AI roster (default false — real shards
   * always spawn their rogues). The benchmark seam: the AI-cost delta
   * (p95 with rogues minus p95 without) measures the machine's tick cost.
   */
  spawnRogues?: boolean;
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
  /**
   * TASK-48: the drone-hover height sampler, per planet (persistent memo).
   * The drones' orbit circles re-sample the same handful of cells every tick,
   * so a PERSISTENT field keeps the hover O(1)-ish per tick — a fresh
   * `planetHeightAt` call would rebuild the noise channels + a per-call cache
   * every drone, every tick (the measured ~30 µs × drone stall), and the
   * shared `TerrainContext` re-primes (evicts) on every position, which is
   * the dead end the handoff warns about.
   */
  private readonly heightSamplers = new Map<string, (x: number, z: number) => number>();
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
  /**
   * TASK-38: the active mining channels (playerId → channel). The tick is
   * the ONLY award path — the server clock is the 1.5 s cadence truth,
   * client messages only assert intent (anti-spam).
   */
  readonly mining = new Map<string, MiningChannel>();
  /**
   * TASK-44: the target locks (playerId → the ship they have locked).
   * Per-player SERVER state: missiles prefer it, the targeted ship's
   * snapshot gains `targetedBy` (the lock icon), and the tick auto-releases
   * on destroy / > 1500 m / 30 s. The client's target box is a view of it.
   */
  readonly targets = new Map<string, { targetId: string; lockedAtMs: number }>();
  /** TASK-34: ground item ids stay unique per shard (handleDrop). */
  private groundItemSeq = 0;
  /** TASK-43: missile ids stay unique per shard (spawn ordering for the cap). */
  private projectileSeq = 0;
  /** TASK-34: ground item ttl in TICKS (300 s at the shard's dt). */
  private readonly groundItemTtlTicks: number;
  /**
   * TASK-45: the system's seeded rogue roster (rosterFor — the SAME pure
   * derivation the client reads). Rogues are a RENEWABLE threat: their
   * hull/damage state lives only while the shard does — NEVER persisted
   * (persist.ts skips kind 'ai-ship') — and on shard reap the next spawn
   * re-derives the roster to full. `respawnAtMs` = epoch ms a destroyed
   * rogue comes back; the tick (single writer) resets it in place at its
   * spawnPos — there is no setTimeout anywhere in the shard.
   */
  private readonly rogues = new Map<string, RogueRosterEntry & { respawnAtMs?: number }>();
  /**
   * TASK-46: the per-rogue AI machine states (keyed by the rogue's entity
   * id). Owned by the tick (single writer); tests read `mode` to assert the
   * state sequence. Rogues are never persisted, so the states die with the
   * shard (and are re-derived on the next spawn).
   */
  readonly ai = new Map<string, AiState>();
  /**
   * TASK-48: the system's seeded hazard cells indexed by planet (the SAME
   * pure derivation the client renders from — positions never stored).
   */
  private readonly hazardsByPlanet = new Map<string, Hazard[]>();
  /**
   * TASK-48: per-player hazard state (the exposure shield pool + the 5 s
   * 'SHIELD BURN' knock-down deadline). Per-player and NON-persistent: it
   * resets on respawn/warp (a tactical resource, not inventory).
   */
  private readonly hazardStates = new Map<string, ExposureState>();
  /**
   * TASK-48: the surface drone machines (entity id → state). Like rogues,
   * drones are a RENEWABLE surface threat — never persisted; a killed drone
   * holds its entity (destroyed, hull 0 on the wire) until the tick respawns
   * it at its patrol start after DRONE_RESPAWN_MS.
   */
  readonly drones = new Map<
    string,
    {
      hazardId: string;
      /** The hazard's planet (for the local-ground hover in the patrol step). */
      planetId: string;
      cell: Vec3;
      orbitRadius: number;
      orbitAngle: number;
      orbitDir: 1 | -1;
      /** Absolute hull points (0..DRONE_HULL); the entity's `hull` is the 0..1 mirror. */
      hullPoints: number;
      nextFireAtMs: number;
      respawnAtMs?: number;
      /** Patrol start (the respawn position). */
      spawnPos: Vec3;
    }
  >();
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
    // TASK-40: the station terminals — one per pad, at the pad edge (the
    // SAME pure derivation the client renders: terminalsFor). The sell
    // flow's on-foot proximity check runs against these entities.
    for (const terminal of terminalsFor(options.galaxySeed, options.system)) {
      this.spawnTerminalEntity(terminal);
    }
    // TASK-45: the seeded rogue AI roster (6-10 ships, 500..3000 u from the
    // star, full hull, space regime). Rogues are a renewable threat — their
    // state resets to full on reap (the shard is dropped; the next spawn
    // re-derives the same roster) — so no persistence row ever exists.
    if (options.spawnRogues !== false) {
      // The patrol loops are seeded from the per-tick shard RNG at tick 0
      // (draw order = roster order — deterministic per system).
      const rng = tickRng(options.systemId, 0);
      for (const entry of rosterFor(options.galaxySeed, options.system)) {
        this.spawnRogueShip(entry);
        this.ai.set(
          entry.aiId,
          createAiState(
            entry.aiId,
            this.now(),
            makeWaypoints(rng, entry.patrolCenter, entry.patrolRadius),
          ),
        );
      }
    }
    // TASK-48: derive the system's seeded hazard cells (the SAME pure
    // function the client renders discs from) and index them by planet.
    for (const hazard of hazardsFor(options.galaxySeed, options.system)) {
      const list = this.hazardsByPlanet.get(hazard.planetId) ?? [];
      list.push(hazard);
      this.hazardsByPlanet.set(hazard.planetId, list);
    }
    // TASK-48: spawn the hostile drones (2-4 per seeded drone cell — their
    // count/kind are deterministic per seed). Orbit phase/direction come from
    // the per-tick shard RNG at tick 0 (draw order = spawn order, like the
    // rogue waypoint seeds — deterministic per system).
    const droneRng = tickRng(options.systemId, 0);
    for (const hazard of hazardsFor(options.galaxySeed, options.system)) {
      if (hazard.kind !== 'drones') continue;
      for (let i = 0; i < hazard.droneCount; i++) {
        this.spawnDroneEntity(hazard, i, droneRng);
      }
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
      // TASK-43: queued fires + the weapon lock belong to the CONNECTION —
      // a reconnect starts clean (no stale shot fires after the drop).
      state.fireQueue = undefined;
      state.weaponLockedUntilMs = undefined;
      state.fireSpamCount = undefined;
      state.fireSpamWindowStartMs = undefined;
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
      // TASK-38: a disconnect kills the player's mining channel — nobody is
      // holding E anymore (the character stays, so the tick cannot see the
      // loss; the channel must not keep awarding into an empty backpack).
      const channel = this.mining.get(state.playerId);
      if (channel) {
        this.mining.delete(state.playerId);
        this.log.info('mining cancelled (disconnect)', {
          playerId: state.playerId,
          deposit: channel.depositId,
          units: channel.unitsSoFar,
        });
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
    // TASK-44: a warp takes the locks with the player — both directions
    // (their own lock, and anyone locked onto the entity that just left;
    // the gone-entity case would also auto-release on the next tick).
    this.targets.delete(playerId);
    if (entity) {
      for (const [lockId, lock] of this.targets) {
        if (lock.targetId === entity.id) this.targets.delete(lockId);
      }
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
   * TASK-23 (extended TASK-42): a weapon hit lands on the target (the
   * sim-side damage hook — resolved, validated contacts arrive via
   * resolveHit / handleWeaponContact). Applies the shared damage model —
   * shields absorb first, overflow reaches the hull — and broadcasts a
   * combat_event to the WHOLE shard: 'hit' per hit (with the firing
   * weapon id), or 'destroyed' (+ 'kill' for a player source) on the
   * killing hit.
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
  applyHit(
    targetId: string,
    amount: number,
    source: DamageSource,
    weaponId: string,
  ): ApplyDamageResult | undefined {
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
      this.destroyEntity(entity, source, weaponId);
    } else {
      this.broadcastCombatEvent({
        kind: 'hit',
        target: entity.id,
        source,
        weapon: weaponId,
        damage: amount,
        shieldHit: result.shieldHit,
        hullHit: result.hullHit,
      });
    }
    return result;
  }

  /**
   * TASK-42: the contact-callback contract for projectiles (TASK-43 wires
   * its flight: laser = instant ray, missile = moving entity). When a
   * projectile reaches its target, the sim calls this with the weapon spec,
   * the firing entity, the intended target and the damage point; the
   * server-side resolver (resolveHit) validates self/dead/range/LOS and
   * applies damage through the TASK-23 pipeline. Fire INTENTS are the only
   * inbound combat traffic — a client never claims a hit (TASK-67).
   */
  handleWeaponContact(
    weapon: WeaponSpec,
    sourceId: string,
    targetId: string,
    damagePoint: Vec3,
  ): ResolveHitOutcome {
    return resolveHit(this, { weapon, sourceId, targetId, damagePoint });
  }

  /**
   * TASK-42: terrain height (m) at (x, z) on a planet — the LOS raycast
   * sampler. Same surface the flight model clamps to (pad disc flattened).
   */
  /**
   * TASK-44: the lockable ship behind an id: exists, kind 'ship'/'ai-ship',
   * not destroyed (v1: NO lock on deposits, terminals, characters or
   * projectiles).
   */
  private lockableShip(targetId: string): SimEntity | undefined {
    const t = this.entities.get(targetId);
    if (!t) return undefined;
    if (t.kind !== 'ship' && t.kind !== 'ai-ship') return undefined;
    if (t.destroyed) return undefined;
    // TASK-49: a docked ship is a safe zone — it can never be locked.
    if (t.docked) return undefined;
    return t;
  }

  /**
   * TASK-44: 'target_lock' {targetId} — the SERVER owns lock state. The
   * player must be in a live ship; the target must be a live ship (never
   * self) within LOCK_RANGE_M and inside the LOCK_CONE_RAD nose cone.
   * Anything else is rejected with {code:'invalid-target'} and NO lock is
   * stored. Re-locking the current target refreshes the 30 s window.
   */
  handleTargetLock(playerId: string, targetId: string, source?: unknown): void {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return;
    if (source !== undefined && conn.source !== source) {
      this.log.debug('dropped target_lock from stale conn', { playerId, connId });
      return;
    }
    const entity = this.playerEntities.get(playerId);
    if (!entity || entity.destroyed || entity.disembarked) {
      this.sendErrorToPlayer(playerId, 'invalid-target', 'no ship to lock from', source);
      return;
    }
    const target = this.lockableShip(targetId);
    const forward = quatRotateVector(entity.ship.quat, { x: 0, y: 0, z: 1 });
    const valid =
      target !== undefined &&
      target.id !== entity.id &&
      coneContains(entity.ship.pos, forward, target.ship.pos, LOCK_RANGE_M, LOCK_CONE_RAD);
    if (!valid) {
      // One code per spec: range / kind / destroyed / gone all fold into
      // 'invalid-target' (the client box can only mean "no lock").
      this.sendErrorToPlayer(playerId, 'invalid-target', 'invalid target', source);
      return;
    }
    this.targets.set(playerId, { targetId: target.id, lockedAtMs: this.now() });
  }

  /** TASK-44: 'target_release' — drops the player's lock (T-key toggle). */
  handleTargetRelease(playerId: string, source?: unknown): void {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return;
    if (source !== undefined && conn.source !== source) return;
    this.targets.delete(playerId);
  }

  /**
   * TASK-44: per-tick auto-release — target destroyed or gone, distance
   * past LOCK_RELEASE_RANGE_M, or the LOCK_TTL_MS window elapsed. Runs
   * before the snapshot so `targetedBy` never shows a dead lock.
   */
  private tickTargetLocks(): void {
    if (this.targets.size === 0) return;
    const now = this.now();
    for (const [playerId, lock] of this.targets) {
      const target = this.entities.get(lock.targetId);
      const shooter = this.playerEntities.get(playerId);
      const expired =
        !target ||
        target.destroyed ||
        !shooter ||
        now - lock.lockedAtMs > LOCK_TTL_MS ||
        vecLength(vecSub(shooter.ship.pos, target.ship.pos)) > LOCK_RELEASE_RANGE_M;
      if (expired) this.targets.delete(playerId);
    }
  }

  /**
   * TASK-44: the missile's target preference — the shooter's VALID lock
   * first, else the nearest ship in the nose cone (30°, 800 m), else
   * undefined (the fire is denied with the 'NO TARGET' prompt). The lock
   * is re-validated here, not assumed: a lock that died this tick falls
   * through to the cone search.
   */
  private missilePreference(playerId: string, entity: SimEntity): SimEntity | undefined {
    const lock = this.targets.get(playerId);
    if (lock) {
      const locked = this.validMissileTarget(entity, lock.targetId);
      if (locked) return locked;
    }
    const forward = quatRotateVector(entity.ship.quat, { x: 0, y: 0, z: 1 });
    const candidates: { id: string; pos: Vec3 }[] = [];
    for (const e of this.entities.values()) {
      if (e.id === entity.id || e.destroyed || e.docked) continue; // TASK-49: skip safe zones
      if (e.kind !== 'ship' && e.kind !== 'ai-ship') continue;
      if (!this.losClear(entity, e.ship.pos)) continue;
      candidates.push({ id: e.id, pos: e.ship.pos });
    }
    const pick = pickNearestInCone(
      entity.ship.pos,
      forward,
      candidates,
      MISSILE_CONE_RANGE_M,
      MISSILE_CONE_RAD,
    );
    return pick ? this.entities.get(pick.id) : undefined;
  }

  terrainHeightAt(planetId: string, x: number, z: number): number {
    const ctx = this.getTerrain(planetId);
    ctx.update(x, z);
    return padSurfaceHeight(x, z, ctx.heightAt(x, z), this.planetPads.get(planetId));
  }

  /**
   * TASK-43: the ONLY inbound combat traffic — a fire INTENT from a conn
   * (WS 'fire' {weapon, targetId?}). The server re-derives everything:
   * stale-conn guard → weapon-lock check → anti-spam counter (30 fires/s →
   * 5 s lock, {code:'weapon-locked'}) → loadout (the class's hardpoints) →
   * per-weapon cooldown → energy (a denied fire emits NO event, spends NO
   * energy — the client sees no FX). Accepted intents are ENQUEUED (the
   * tick resolves them: single writer); energy + cooldown are committed at
   * ACCEPTANCE time so a queued fire is exactly one shot.
   */
  handleFire(
    playerId: string,
    payload: { weapon: string; targetId?: string },
    source?: unknown,
  ): void {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return;
    if (source !== undefined && conn.source !== source) {
      this.log.debug('dropped fire from stale conn', { playerId, connId });
      return;
    }
    const now = this.now();
    // Weapon lock (30 fires/s from this conn): everything is rejected.
    if ((conn.weaponLockedUntilMs ?? 0) > now) {
      this.sendErrorToPlayer(playerId, 'weapon-locked', 'WEAPONS LOCKED (spam)', source);
      return;
    }
    // Anti-spam window: 1 s sliding-ish (fixed 1 s windows are good enough
    // for a lockout — the spec's 30 fires/s trigger).
    if (conn.fireSpamWindowStartMs === undefined || now - conn.fireSpamWindowStartMs >= 1000) {
      conn.fireSpamWindowStartMs = now;
      conn.fireSpamCount = 0;
    }
    conn.fireSpamCount = (conn.fireSpamCount ?? 0) + 1;
    if (conn.fireSpamCount >= FIRE_SPAM_LIMIT) {
      conn.weaponLockedUntilMs = now + WEAPON_LOCK_MS;
      this.log.warn('weapon lock: fire spam', { playerId, connId, count: conn.fireSpamCount });
      this.sendErrorToPlayer(playerId, 'weapon-locked', 'WEAPONS LOCKED (spam)', source);
      return;
    }
    const weapon = WEAPON_BY_ID[payload.weapon as WeaponId];
    if (!weapon) {
      this.log.debug('dropped fire: unknown weapon', { playerId, weapon: payload.weapon });
      return;
    }
    const entity = this.playerEntities.get(playerId);
    // No ship (or destroyed / on foot): on-foot has no weapons in v1.
    if (!entity || entity.destroyed || entity.disembarked) {
      this.log.debug('dropped fire: no live ship', { playerId, weapon: weapon.id });
      return;
    }
    if (!loadoutFor(entity.classId).some((w) => w.id === weapon.id)) {
      this.log.debug('dropped fire: not in loadout', {
        playerId,
        classId: entity.classId,
        weapon: weapon.id,
      });
      return;
    }
    if ((entity.fireCooldownUntil?.[weapon.id] ?? 0) > this.sim.tickNumber) {
      // Rate-limited drop: logged, no energy spent, no event (spec).
      this.log.debug('dropped fire: rate limited', {
        playerId,
        weapon: weapon.id,
        tick: this.sim.tickNumber,
      });
      return;
    }
    if (!canFire(entity.energy ?? ENERGY_MAX, weapon)) {
      // 'LOW ENERGY' prompt for the client; the fire is denied, no FX.
      this.sendErrorToPlayer(playerId, 'low-energy', 'LOW ENERGY', source);
      return;
    }
    // TASK-44: missiles need a target — the shooter's LOCK first, else the
    // nearest ship in the nose cone. Denied fires spend nothing and answer
    // with the 'NO TARGET' prompt (no wasted ammo silently). The tick
    // re-validates: a target lost between now and then is refunded.
    // (payload.targetId stays the LASER's aim assist only.)
    let missileTargetId: string | undefined;
    if (weapon.kind === 'missile') {
      const picked = this.missilePreference(playerId, entity);
      if (!picked) {
        this.sendErrorToPlayer(playerId, 'no-target', 'NO TARGET', source);
        return;
      }
      missileTargetId = picked.id;
    }
    // ACCEPTED: commit energy + cooldown now (a queued fire is one shot),
    // enqueue for the tick (cap: overflow drops + logs).
    entity.energy = spendEnergy(entity.energy ?? ENERGY_MAX, weapon);
    const cooldownTicks = Math.max(1, Math.ceil(1 / ((weapon.fireRate ?? 1) * this.dt)));
    entity.fireCooldownUntil = {
      ...(entity.fireCooldownUntil ?? {}),
      [weapon.id]: this.sim.tickNumber + cooldownTicks,
    };
    const queue = conn.fireQueue ?? (conn.fireQueue = []);
    if (queue.length >= FIRE_QUEUE_MAX) {
      this.log.debug('dropped fire: queue full', { playerId, weapon: weapon.id });
      return;
    }
    queue.push({
      weapon: weapon.id,
      targetId: weapon.kind === 'missile' ? missileTargetId : payload.targetId,
    });
  }

  /** True when the source → point ray is clear (space regime skips LOS). */
  private losClear(source: SimEntity, point: Vec3): boolean {
    if (source.ship.regime === 'space' || !source.planetId) return true;
    const planetId = source.planetId;
    return lineOfSight(source.ship.pos, point, (x, z) => this.terrainHeightAt(planetId, x, z));
  }

  /** TASK-43: resolve every conn's queued fire intents (single writer). */
  private processFireIntents(tick: number): void {
    for (const conn of this.connections.values()) {
      const queue = conn.fireQueue;
      if (!queue || queue.length === 0) continue;
      conn.fireQueue = [];
      for (const intent of queue) this.resolveFireIntent(conn, intent, tick);
    }
  }

  /** One queued fire intent, resolved in the tick (single writer). */
  private resolveFireIntent(
    conn: ConnState,
    intent: { weapon: WeaponId; targetId?: string },
    tick: number,
  ): void {
    const entity = this.playerEntities.get(conn.playerId);
    if (!entity || entity.destroyed || entity.disembarked) return;
    const weapon = WEAPON_BY_ID[intent.weapon];
    if (!weapon) return;
    // The cooldown + energy were committed at ACCEPTANCE (handleFire) — a
    // second accepted fire cannot be queued behind it (its handleFire
    // cooldown check failed). Only the loadout is re-checked here (a ship
    // swap between enqueue and tick is the race this guards).
    if (!loadoutFor(entity.classId).some((w) => w.id === weapon.id)) return;
    const nose = vecAdd(
      entity.ship.pos,
      vecScale(quatRotateVector(entity.ship.quat, { x: 0, y: 0, z: 1 }), NOSE_OFFSET_M),
    );
    const forward = quatRotateVector(entity.ship.quat, { x: 0, y: 0, z: 1 });
    const source: DamageSource = { kind: 'player', id: conn.playerId };
    if (weapon.kind !== 'missile') {
      this.fireLaser(entity, weapon, nose, forward, intent.targetId, source);
    } else {
      this.fireMissile(entity, weapon, nose, forward, intent.targetId, source, tick);
    }
  }

  /**
   * Laser: instant ray nose → first valid target (within range + LOS) or
   * the terrain-occlusion point or max range. The chosen damage point goes
   * through the TASK-42 resolveHit pipeline; the 'laser-fired' FX event is
   * broadcast for EVERY accepted fire (hit or not).
   */
  private fireLaser(
    entity: SimEntity,
    weapon: WeaponSpec,
    nose: Vec3,
    forward: Vec3,
    targetId: string | undefined,
    source: DamageSource,
  ): void {
    let target: SimEntity | undefined;
    if (targetId && targetId !== entity.id) {
      const t = this.entities.get(targetId);
      // TASK-49: a docked target is a safe zone — the beam passes over it.
      if (t && (t.kind === 'ship' || t.kind === 'ai-ship') && !t.destroyed && !t.docked) {
        if (
          vecLength(vecSub(t.ship.pos, nose)) <= weapon.range &&
          this.losClear(entity, t.ship.pos)
        ) {
          target = t;
        }
      }
    }
    // No (valid) client target: raycast the first entity along the ray.
    let hitT: number | undefined;
    if (!target) {
      let best: { entity: SimEntity; t: number } | undefined;
      for (const e of this.entities.values()) {
        if (e.id === entity.id || e.kind === 'wreck' || e.destroyed || e.docked) continue;
        if (e.kind !== 'ship' && e.kind !== 'ai-ship') continue;
        const to = vecSub(e.ship.pos, nose);
        const t = vecDot(to, forward);
        if (t <= 0 || t > weapon.range) continue;
        const perp = vecLength(vecSub(to, vecScale(forward, t)));
        if (perp <= LASER_HIT_RADIUS_M && (!best || t < best.t)) best = { entity: e, t };
      }
      if (best) {
        target = best.entity;
        hitT = best.t;
      }
    }
    // Terrain occlusion (surface regime): the first subsample below terrain.
    let endT = weapon.range;
    if (target) {
      endT = hitT ?? Math.min(weapon.range, vecLength(vecSub(target.ship.pos, nose)));
    }
    if (entity.planetId && entity.ship.regime !== 'space') {
      const stepM = weapon.range / 20;
      for (let d = stepM; d < endT; d += stepM) {
        const p = vecAdd(nose, vecScale(forward, d));
        if (p.y < this.terrainHeightAt(entity.planetId, p.x, p.z)) {
          endT = d;
          target = undefined;
          break;
        }
      }
    }
    const damagePoint = vecAdd(nose, vecScale(forward, endT));
    // TASK-46: a player beam that resolved onto a rogue feeds its 5 s
    // aggro memory (the "player fired on the AI" trigger).
    if (target && source.kind === 'player' && target.kind === 'ai-ship') {
      this.notePlayerFireAt(target.id, source.id);
    }
    // The fired-FX event goes out BEFORE the hit (the beam leads the damage;
    // the client's line flash plays as the impact lands on the same frame).
    this.broadcastCombatEvent({
      kind: 'laser-fired',
      source,
      weapon: weapon.id,
      from: nose,
      to: target ? target.ship.pos : damagePoint,
    });
    if (target) {
      this.handleWeaponContact(weapon, entity.id, target.id, target.ship.pos);
    }
  }

  /**
   * The missile's target right now: alive, in range of the NOSE, with LOS —
   * or undefined when the fire cannot resolve (a denied drop: silent, and a
   * fire already accepted at handleFire has its energy REFUNDED).
   */
  private validMissileTarget(
    entity: SimEntity,
    targetId: string | undefined,
  ): SimEntity | undefined {
    if (!targetId || targetId === entity.id) return undefined;
    const t = this.entities.get(targetId);
    // TASK-49: a docked target is a safe zone — missiles can't lock it.
    if (!t || (t.kind !== 'ship' && t.kind !== 'ai-ship') || t.destroyed || t.docked)
      return undefined;
    const nose = vecAdd(
      entity.ship.pos,
      vecScale(quatRotateVector(entity.ship.quat, { x: 0, y: 0, z: 1 }), NOSE_OFFSET_M),
    );
    if (vecLength(vecSub(t.ship.pos, nose)) > (WEAPON_BY_ID.missile.range ?? 800)) return undefined;
    if (!this.losClear(entity, t.ship.pos)) return undefined;
    return t;
  }

  /**
   * TASK-46: a player's shot landed in a rogue's aggro memory — "the player
   * fired on the AI within the last 5 s" is the second aggro trigger (the
   * first is the range + cone test). Called from both fire paths with the
   * RESOLVED target (a shot that hits rock does not aggro).
   */
  private notePlayerFireAt(aiId: string, playerId: string): void {
    const state = this.ai.get(aiId);
    if (!state) return;
    // Aggro candidates match on the player's ENTITY id (ai.ts), not the
    // player id — remember the entity.
    state.lastPlayerFireBy = this.playerEntities.get(playerId)?.id ?? playerId;
    state.lastPlayerFireAtMs = this.now();
  }

  /**
   * Missile: needs a VALID client target (alive, in range, LOS) — otherwise
   * the fire is a denied drop (no FX; a target lost between acceptance and
   * tick refunds the committed energy). Spawns a projectile ENTITY (visible
   * in snapshots for every client), enforcing the 16-per-shard cap (the
   * OLDEST expires first, logged).
   */
  private fireMissile(
    entity: SimEntity,
    weapon: WeaponSpec,
    nose: Vec3,
    forward: Vec3,
    targetId: string | undefined,
    source: DamageSource,
    tick: number,
  ): void {
    const target = this.validMissileTarget(entity, targetId);
    if (!target) {
      // The energy was committed at ACCEPTANCE (handleFire): give it back —
      // a denied fire spends nothing (spec).
      entity.energy = Math.min(ENERGY_MAX, (entity.energy ?? ENERGY_MAX) + (weapon.energy ?? 0));
      this.log.debug('dropped missile: no valid target', {
        playerId: entity.playerId ?? null,
        tick,
      });
      return;
    }
    // TASK-46: a player missile aimed at a rogue feeds its 5 s aggro memory.
    if (source.kind === 'player' && target.kind === 'ai-ship') {
      this.notePlayerFireAt(target.id, source.id);
    }
    // Entity budget: the oldest projectile expires first when the cap is hit.
    const projectiles: SimEntity[] = [];
    for (const e of this.entities.values()) {
      if (e.kind === 'projectile') projectiles.push(e);
    }
    if (projectiles.length >= PROJECTILE_CAP) {
      projectiles.sort((a, b) => (a.projectile?.spawnTick ?? 0) - (b.projectile?.spawnTick ?? 0));
      const oldest = projectiles[0];
      this.entities.delete(oldest.id);
      this.log.warn('missile cap hit: oldest expired', {
        projectId: oldest.id,
        cap: PROJECTILE_CAP,
      });
    }
    const seq = ++this.projectileSeq;
    const id = `proj:${seq}`;
    this.entities.set(id, {
      id,
      kind: 'projectile',
      playerId: null,
      classId: 'missile',
      ship: {
        pos: nose,
        vel: vecScale(forward, weapon.speed ?? 120),
        quat: entity.ship.quat,
        regime: entity.ship.regime,
      },
      hull: 0,
      shields: 0,
      targetId: target.id,
      docked: false,
      ttl: Math.max(1, Math.round((weapon.ttl ?? 5) / this.dt)),
      planetId: entity.planetId,
      projectile: { targetId: target.id, sourceId: entity.id, weaponId: 'missile', spawnTick: seq },
    });
    this.broadcastCombatEvent({
      kind: 'missile-fired',
      source,
      weapon: weapon.id,
      projectile: id,
      from: nose,
    });
  }

  /**
   * One tick of missile flight: home (turn-rate capped) toward the target,
   * advance at constant speed, decrement the ttl (expiry = a miss, no hit),
   * detonate on contact (splash radius) or terrain impact.
   */
  private updateProjectiles(): void {
    for (const [id, proj] of this.entities) {
      if (proj.kind !== 'projectile' || !proj.projectile) continue;
      const spec = WEAPON_BY_ID.missile;
      if (proj.ttl !== undefined && --proj.ttl <= 0) {
        // Expired: the target outran the turn rate — no hit (spec).
        this.entities.delete(id);
        this.log.debug('missile expired (no hit)', { projectId: id });
        continue;
      }
      const st = proj.projectile;
      const target = this.entities.get(st.targetId);
      const targetAlive =
        !!target && (target.kind === 'ship' || target.kind === 'ai-ship') && !target.destroyed;
      if (targetAlive && target) {
        const step = stepMissile(
          proj.ship.pos,
          proj.ship.vel,
          target.ship.pos,
          this.dt,
          spec.speed ?? 120,
          spec.turnRate ?? 1.5,
        );
        proj.ship.pos = step.pos;
        proj.ship.vel = step.vel;
        if (vecLength(vecSub(target.ship.pos, proj.ship.pos)) <= (spec.splashRadius ?? 5)) {
          this.detonateMissile(id, proj, proj.ship.pos, target);
          continue;
        }
      } else {
        // Dead/lost target: fly straight to the ttl (a guaranteed miss).
        proj.ship.pos = vecAdd(proj.ship.pos, vecScale(proj.ship.vel, this.dt));
      }
      // Terrain impact (atmosphere/surface only): splash at the ground.
      if (
        proj.planetId &&
        proj.ship.pos.y <= this.terrainHeightAt(proj.planetId, proj.ship.pos.x, proj.ship.pos.z)
      ) {
        this.detonateMissile(id, proj, proj.ship.pos, undefined);
      }
    }
  }

  /**
   * Missile detonation: the 'missile-impact' FX event goes out FIRST (the
   * impact leads the damage, like the laser — the AC order fired → impact →
   * hit), then 25 damage to the target (when one was in contact), 12 splash
   * to EVERYTHING else within 5 m (friendly fire applies — one pipeline, no
   * teams), and removal.
   */
  private detonateMissile(
    id: string,
    proj: SimEntity,
    point: Vec3,
    direct: SimEntity | undefined,
  ): void {
    const st = proj.projectile!;
    const srcEntity = this.entities.get(st.sourceId);
    const source = srcEntity?.playerId
      ? ({ kind: 'player', id: srcEntity.playerId } as const)
      : ({ kind: 'ai', id: st.sourceId } as const);
    // The impact-FX event leads the damage (the AC order: fired → impact → hit).
    this.broadcastCombatEvent({ kind: 'missile-impact', weapon: 'missile', projectile: id, point });
    if (direct) {
      this.applyHit(direct.id, WEAPON_BY_ID.missile.damage, source, 'missile');
    }
    for (const e of this.entities.values()) {
      if (direct && e.id === direct.id) continue;
      if (e.kind !== 'ship' && e.kind !== 'ai-ship') continue;
      if (e.destroyed) continue;
      if (vecLength(vecSub(e.ship.pos, point)) <= (WEAPON_BY_ID.missile.splashRadius ?? 5)) {
        this.applyHit(e.id, WEAPON_BY_ID.missile.splashDamage ?? 12, source, 'missile');
      }
    }
    this.entities.delete(id);
  }

  /**
   * TASK-46: the SAME loadout + cooldown + energy checks the player's
   * handleFire commits — the machine only asks to fire when this passes, so
   * a rogue's shots are rate-limited and energy-capped exactly like a
   * player's (no infinite ammo, AC).
   */
  private aiCanFire(entity: SimEntity, weapon: WeaponId): boolean {
    if (entity.destroyed || entity.docked) return false; // the docked guard (rogues never dock in v1)
    if (!loadoutFor(entity.classId).some((w) => w.id === weapon)) return false;
    if ((entity.fireCooldownUntil?.[weapon] ?? 0) > this.sim.tickNumber) return false;
    if (!canFire(entity.energy ?? ENERGY_MAX, WEAPON_BY_ID[weapon])) return false;
    return true;
  }

  /**
   * TASK-46: resolve one AI fire intent in the tick — energy + cooldown
   * committed at ACCEPTANCE (mirroring handleFire), then the SAME
   * fireLaser / fireMissile pipeline the players use with source = the AI,
   * so hit/kill attribution reads {kind:'ai', id} (one pipeline, two input
   * sources — this is what keeps PvP/PvE parity real).
   */
  private resolveAiFire(
    entity: SimEntity,
    intent: { weapon: WeaponId; targetId: string },
    tick: number,
  ): void {
    const weapon = WEAPON_BY_ID[intent.weapon];
    if (!this.aiCanFire(entity, weapon.id)) return; // re-checked in the tick (single writer)
    entity.energy = spendEnergy(entity.energy ?? ENERGY_MAX, weapon);
    const cooldownTicks = Math.max(1, Math.ceil(1 / ((weapon.fireRate ?? 1) * this.dt)));
    entity.fireCooldownUntil = {
      ...(entity.fireCooldownUntil ?? {}),
      [weapon.id]: this.sim.tickNumber + cooldownTicks,
    };
    const nose = vecAdd(
      entity.ship.pos,
      vecScale(quatRotateVector(entity.ship.quat, { x: 0, y: 0, z: 1 }), NOSE_OFFSET_M),
    );
    const forward = quatRotateVector(entity.ship.quat, { x: 0, y: 0, z: 1 });
    const source: DamageSource = { kind: 'ai', id: entity.id };
    if (weapon.kind !== 'missile')
      this.fireLaser(entity, weapon, nose, forward, intent.targetId, source);
    else this.fireMissile(entity, weapon, nose, forward, intent.targetId, source, tick);
  }

  /**
   * TASK-46: one tick of rogue AI. Each rogue's state machine (./ai)
   * computes the ShipInput fed to the SAME integrateShip the players use
   * (the AI is just another ship whose inputs come from the machine, not a
   * ws client) and — once acquired — a fire intent resolved through the
   * player fire pipeline. Rogues never target rogues: `players` is the
   * player-ship list ONLY. All randomness draws from the per-tick shard RNG
   * (systemId ^ tick — the determinism AC).
   */
  private stepAiShips(tick: number): void {
    if (this.ai.size === 0) return;
    const now = this.now();
    const players: AiPlayerView[] = [];
    for (const e of this.playerEntities.values()) {
      // TASK-49: docked ships are safe zones — a rogue never targets one
      // (the aggro cone + fire-memory both read this list).
      if (e.destroyed || e.disembarked || e.docked) continue;
      players.push({ id: e.id, pos: e.ship.pos, vel: e.ship.vel });
    }
    const rng = tickRng(this.systemId, tick);
    for (const [id, rogue] of this.rogues) {
      const entity = this.entities.get(id);
      if (!entity || entity.kind !== 'ai-ship') continue;
      if (entity.docked) continue; // guard: a docked AI neither thinks nor fires
      const state = this.ai.get(id);
      if (!state) continue;
      if (entity.destroyed) {
        if (state.mode !== 'dead') {
          state.mode = 'dead';
          state.lastModeChangeAtMs = now;
          this.log.debug('ai mode change', { id, from: state.mode, to: 'dead' });
        }
        continue;
      }
      if (state.mode === 'dead') {
        // the TASK-45 respawn sweep just reset the entity in place: PATROL again
        resetAiState(state, rng, rogue.patrolCenter, rogue.patrolRadius, now);
      }
      const world: AiWorld = {
        tick,
        nowMs: now,
        dt: this.dt,
        hull: entity.hull,
        players,
        canFire: (w) => this.aiCanFire(entity, w),
      };
      const prev = state.mode;
      const result = stepAi(state, entity.ship, shipStats(entity.classId), world);
      if (state.mode !== prev) {
        this.log.debug('ai mode change', {
          id,
          from: prev,
          to: state.mode,
          targetId: state.targetId,
        });
      }
      entity.ship = integrateShip(
        entity.ship,
        result.input,
        this.dt,
        entity.ship.regime,
        undefined,
        shipStats(entity.classId),
      );
      // TASK-43 parity: the same energy regen as player ships (no infinite ammo).
      entity.energy = regenEnergy(entity.energy ?? ENERGY_MAX, this.dt);
      if (result.acquiring) {
        // The 1 s acquire delay doubles as a UI hook: the 'ACQUIRING' toast
        // gives the player the grace period (gameplay, not a cheat).
        this.broadcastCombatEvent({
          kind: 'ai-acquiring',
          source: { kind: 'ai', id: entity.id },
          target: result.acquiring,
        });
      }
      if (result.fire) this.resolveAiFire(entity, result.fire, tick);
    }
  }

  /**
   * Destroy a ship (the killing step of applyHit): freeze it (hull/shields 0,
   * no held input, no target) and spawn a static wreck at its final position
   * with the 600 s ttl. The wreck is a NEW entity (id `wreck:<shipId>`) so
   * the frozen ship — which a dock respawn re-adopts in TASK-49 — and the
   * expiring wreck are independent. TASK-42: the wreck carries the killer's
   * id (skull marker, TASK-49), the 'destroyed' event carries the weapon,
   * and a PLAYER source additionally broadcasts the 'kill' event.
   */
  private destroyEntity(entity: SimEntity, source: DamageSource, weaponId: string): void {
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
      killerId: source.id, // TASK-42: skull marker until despawn (TASK-49)
    });
    this.broadcastCombatEvent({ kind: 'destroyed', target: entity.id, source, weapon: weaponId });
    if (source.kind === 'player') {
      // kill = destroyed with a player source (the PvP kill feed / toasts).
      this.broadcastCombatEvent({
        kind: 'kill',
        killer: source.id,
        victim: entity.id,
        weapon: weaponId,
      });
    }
    if (entity.kind === 'ai-ship') {
      // TASK-45: the rogue comes back at its spawnPos ROGUE_RESPAWN_MS
      // later — the tick is the timer (single writer, no setTimeout).
      const rogue = this.rogues.get(entity.id);
      if (rogue) rogue.respawnAtMs = this.now() + ROGUE_RESPAWN_MS;
    }
    // TASK-49: a destroyed PLAYER ship loses its cargo and respawns IMMEDIATELY
    // at the nearest dock in a fresh starter scout (immediate server-side — the
    // 2 s 'SHIP LOST' moment is client presentation, driven by the 'destroyed'
    // event above). A destroyed ship is by construction one its player is IN:
    // docked / disembarked ships are weapon-invulnerable (step 2), so the
    // "destroyed while on foot" edge cannot occur here.
    if (entity.kind === 'ship' && entity.playerId) {
      this.respawnPlayer(entity.playerId);
    }
    this.log.info('ship destroyed', {
      target: entity.id,
      source: source.id,
      weapon: weaponId,
      wreck: `wreck:${entity.id}`,
    });
  }

  /**
   * TASK-49: the nearest dock for a respawn — the pad in THIS system whose
   * center is closest (true 3D distance) to the given position. A ship killed
   * in open space respawns at the nearest station's pad; there is no
   * cross-system respawn in v1 (the player stays in that system's economy — a
   * soft consequence, documented in the spec). Returns undefined for a
   * system with no landable pad (the caller then docks at the home dock).
   */
  private nearestDockPad(pos: Vec3): PadInfo | undefined {
    let best: PadInfo | undefined;
    let bestD = Infinity;
    for (const pad of this.planetPads.values()) {
      const d = vecLength(vecSub(pos, pad.pos));
      if (d < bestD || (d === bestD && (!best || pad.padId < best.padId))) {
        best = pad;
        bestD = d;
      }
    }
    return best;
  }

  /**
   * TASK-49: respawn a player at the nearest dock in a fresh starter scout
   * (full hull/shields, starter livery, docked). Called from the destruction
   * path (the single writer). The SAME sim entity is reset in place — its id
   * is wire-stable, so the client's self-ship mesh just re-renders (the
   * classId change rebuilds it as a scout) and the frozen wreck stays
   * independent (`wreck:<id>`, its own ttl).
   *
   * - CARGO IS LOST: the ship's hold is cleared (PRD risk model — mining trips
   *   are the stakes, not the player).
   * - CREDITS + on-foot INVENTORY SURVIVE: `entity.inventory` is untouched.
   *
   * The old ship's DB record is replaced in one transaction (respawnShip —
   * classId → scout, full caps, docked, cargo scrubbed, destroyed_at scrubbed).
   */
  respawnPlayer(playerId: string): { pad: PadInfo; shipId: string } | undefined {
    const entity = this.playerEntities.get(playerId);
    if (!entity || entity.kind !== 'ship') return undefined;
    if (!entity.destroyed) return undefined; // only a destroyed ship respawns here
    const dock = this.nearestDockPad(entity.ship.pos);
    const scout = SHIP_CLASSES.scout;
    // The respawn position: the nearest pad's surface, or (no landable pad)
    // the seed-derived home dock in open space.
    const padId = dock?.padId;
    const pos: Vec3 = dock
      ? { ...dock.pos }
      : { ...homeDockPosition(this.galaxySeed, this.systemId) };
    const regime: SimEntity['ship']['regime'] = dock ? 'surface' : 'space';
    entity.cargo = undefined; // LOST (credits + inventory are kept — untouched)
    entity.classId = 'scout';
    entity.hull = 1;
    entity.shields = 1;
    entity.livery = { ...scout.defaultLivery };
    entity.ship = {
      pos,
      vel: { x: 0, y: 0, z: 0 },
      quat: quatIdentity(),
      regime,
      ...(padId ? { onPad: padId } : {}),
    };
    entity.destroyed = false;
    entity.destroyedAtMs = undefined;
    entity.docked = true;
    entity.padId = padId;
    entity.planetId = dock?.planetId;
    entity.energy = ENERGY_MAX;
    entity.fireCooldownUntil = undefined;
    entity.heldInput = undefined;
    entity.idle = !this.playerConns.has(playerId);
    // Persist: replace the record (classId → scout, full caps, docked, cargo
    // scrubbed) in one transaction. Best-effort — a persistence failure must
    // never wedge the tick; the in-shard entity (the wire authority) is done.
    this.persistRespawn(entity, pos);
    this.log.info('player respawned at dock', {
      playerId,
      ship: entity.id,
      padId: padId ?? 'home-dock',
    });
    return {
      pad: dock ?? { padId: '', planetId: '', pos, normal: { x: 0, y: 1, z: 0 }, radius: 0 },
      shipId: entity.id,
    };
  }

  /** TASK-49: persist the respawn (best-effort, one transaction, no throw). */
  private persistRespawn(entity: SimEntity, pos: Vec3): void {
    const repo = this.repo;
    if (typeof repo.withTransaction !== 'function') return; // test stub without tx
    void repo
      .withTransaction(async (tx) => {
        if (typeof tx.respawnShip !== 'function') return;
        await tx.respawnShip(entity.id, {
          position: { systemId: this.systemId, x: pos.x, y: pos.y, z: pos.z },
          rotation: entity.ship.quat,
          regime: entity.ship.regime as import('@server/db/schema').ShipRegime,
          onPad: entity.padId ?? null,
        });
      })
      .catch((err: unknown) => {
        this.log.warn('respawn persist failed', { ship: entity.id, error: String(err) });
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
    // TASK-44: targetId → the players locking it (the lock icon's wire data).
    const lockIcons = this.lockIconsByTarget();
    for (const entity of this.entities.values()) {
      if (entity.kind === 'deposit' && entity.depositSeq !== undefined) {
        if (!playerPos) playerPos = this.playerPositions();
        const near = playerPos.some(
          (p) => vecLength(vecSub(entity.ship.pos, p)) <= DEPOSIT_RENDER_RANGE_M,
        );
        if (!near) continue;
      }
      out.push(entityToState(entity, lockIcons?.get(entity.id)));
    }
    return out;
  }

  /** One sim tick: drain inputs, integrate, snapshot on even ticks. */
  private tick(tick: number): void {
    const t0 = performance.now();

    // TASK-23: expire static wrecks (600 s ttl) — bounds the entity count.
    // TASK-43: projectiles manage their OWN ttl (updateProjectiles decrements
    // AND detonates on contact — the sweep must not double-decrement them).
    for (const [id, entity] of this.entities) {
      if (entity.kind === 'projectile') continue;
      if (entity.ttl !== undefined && --entity.ttl === 0) this.entities.delete(id);
    }

    // TASK-45: rogue respawns — a destroyed ai-ship resets IN PLACE at its
    // spawnPos once now() reaches its respawnAtMs (the tick is the timer —
    // no setTimeout in the shard). Same wire id: clients keep the entity,
    // no join event; stale target locks auto-release via tickTargetLocks.
    const now = this.now();
    for (const [id, rogue] of this.rogues) {
      if (rogue.respawnAtMs === undefined || now < rogue.respawnAtMs) continue;
      const entity = this.entities.get(id);
      rogue.respawnAtMs = undefined;
      if (!entity || !entity.destroyed) continue;
      entity.destroyed = false;
      entity.destroyedAtMs = undefined;
      entity.hull = 1;
      entity.shields = 1;
      entity.ship.pos = { ...rogue.spawnPos };
      entity.ship.vel = { x: 0, y: 0, z: 0 };
      entity.energy = ENERGY_MAX;
      this.log.debug('rogue respawn', { id, classId: entity.classId });
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
      // TASK-43: energy regen (10/s, max 100) — including while docked or
      // disembarked (the idle tick keeps regenerating, spec note).
      entity.energy = regenEnergy(entity.energy ?? ENERGY_MAX, this.dt);
    }

    // TASK-48: hazard exposure — drain (storm 2/s, rad 5/s) / regen (5/s
    // outside) per on-foot player BEFORE the character integration, so a
    // knock-down (exposure 0 → 5 s 'recovering') freezes THAT tick's input.
    this.stepHazardExposure();

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
      // TASK-48: a recovering player (SHIELD BURN knock-down) cannot move —
      // the tick feeds zero input for the whole 5 s window.
      const recovering =
        (this.hazardStates.get(entity.playerId)?.recoveringUntilMs ?? 0) > this.now();
      const next = integrateCharacter(
        charState,
        recovering ? ZERO_CHARACTER_INPUT : inputToCharacterInput(entity.heldInput ?? ZERO_INPUT),
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

    // TASK-48: hostile drones — patrol their seeded cells, aggro the nearest
    // on-foot player (< 80 m), hit for 3 through the damage pipeline (2 s
    // cadence, ≤ 30 m), respawn 180 s after a kill. Ships are never targets.
    this.stepDrones();

    // TASK-38: advance the active mining channels (the server clock is the
    // award authority — awards, cancellations and the 10 Hz progress echo).
    this.updateMining(tick);

    // TASK-46: rogue AI — state machine inputs via the same integrateShip,
    // fire intents through the same pipeline (runs before the fire sweeps so
    // AI missiles spawn + fly this tick, like a player's queued fire).
    this.stepAiShips(tick);

    // TASK-44: auto-release stale target locks BEFORE firing, so missile
    // preference and the snapshot's `targetedBy` never see a dead lock.
    this.tickTargetLocks();

    // TASK-43: resolve queued fire intents (laser: instant ray through the
    // TASK-42 resolver; missile: spawn a homing projectile entity) — the
    // tick is the ONLY fire path (single writer). Then fly the missiles.
    this.processFireIntents(tick);
    this.updateProjectiles();

    // TASK-37: deposit discovery (any player within 50 m flips the flag).
    this.sweepDiscovery();

    // 10 Hz snapshot: every 2nd tick, serialize ONCE, share the buffer.
    if (tick % SNAPSHOT_EVERY_TICKS === 0 && this.entities.size > 0 && this.connections.size > 0) {
      this.broadcast();
    }
    // 10 Hz acks: tell each connection the last input seq APPLIED (TASK-14).
    if (tick % SNAPSHOT_EVERY_TICKS === 0) this.sendAcks();
    // TASK-48: 10 Hz per-connection hazard frames (exposure pool + knock-down
    // deadline) for on-foot players — the client's exposure meter reads them.
    if (tick % SNAPSHOT_EVERY_TICKS === 0) this.sendHazardFrames();

    const ms = performance.now() - t0;
    this.histogram.record(ms);
    this.events.emit('tick', { tick, ms, entities: this.entities.size });
  }

  /** TASK-44: targetId → the player ids locking it (sorted, deterministic). */
  private lockIconsByTarget(): Map<string, string[]> | undefined {
    if (this.targets.size === 0) return undefined;
    const m = new Map<string, string[]>();
    for (const [playerId, lock] of this.targets) {
      const arr = m.get(lock.targetId) ?? [];
      arr.push(playerId);
      m.set(lock.targetId, arr);
    }
    for (const arr of m.values()) arr.sort();
    return m;
  }

  /**
   * TASK-44 e2e/test hook: a static ai-ship dummy DIRECTLY ahead of the
   * player's ship (along its forward, `distance` m — always inside the lock
   * cone by construction). The dev route /api/dev/dummy-target uses it so a
   * single browser client can lock a live ship-shaped target.
   */
  spawnDummyTargetForTesting(playerId: string, distance = 200): string | undefined {
    const entity = this.playerEntities.get(playerId);
    if (!entity) return undefined;
    const forward = quatRotateVector(entity.ship.quat, { x: 0, y: 0, z: 1 });
    const seq = ++this.devDepositSeq;
    const id = `ai:dummy:${seq}`;
    this.addEntity({
      id,
      kind: 'ai-ship',
      playerId: null,
      classId: 'scout',
      ship: {
        pos: vecAdd(entity.ship.pos, vecScale(forward, Math.abs(distance))),
        vel: { x: 0, y: 0, z: 0 },
        quat: entity.ship.quat,
        regime: entity.ship.regime,
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      planetId: entity.planetId,
      callsign: `AI-001-${seq}`,
    });
    return id;
  }

  /**
   * TASK-50 e2e hook: broadcast a 'kill' combat_event (the client kill
   * feed's ONLY input) for a scripted scene. No entity state is touched —
   * it is the pure broadcast path; the client resolves killer (player id →
   * presence roster) and victim (ship id → entity batches) to callsigns.
   */
  broadcastKillForTesting(killerPlayerId: string, victimShipId: string, weapon: string): void {
    this.broadcastCombatEvent({
      kind: 'kill',
      killer: killerPlayerId,
      victim: victimShipId,
      weapon,
    });
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

  // ---------------------------------------------------------------------
  // TASK-48: surface hazards (exposure pool) + hostile drones
  // ---------------------------------------------------------------------

  /**
   * The exposure-draining cell a character stands in, or null: drones-kind
   * cells drain nothing (their threat is the drone machines themselves).
   */
  private hazardForCharacter(entity: SimEntity): DrainKind | null {
    if (!entity.planetId) return null;
    const cell = hazardAt(
      this.hazardsByPlanet.get(entity.planetId) ?? [],
      entity.ship.pos,
      entity.planetId,
    );
    if (!cell || cell.kind === 'drones') return null;
    return cell.kind;
  }

  /**
   * One exposure step per on-foot player (AC step 1): drain inside a cell
   * (storm 2/s, rad 5/s — the pure shared math), regen 5/s outside, and the
   * knock-down transition (exposure 0 → 5 s 'recovering', 'SHIELD BURN').
   * The state is per-player and NON-persistent (it resets on respawn/warp).
   */
  private stepHazardExposure(): void {
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'character' || !entity.playerId) continue;
      const prev = this.hazardStates.get(entity.playerId) ?? FULL_EXPOSURE;
      const { state, knocked } = tickExposure(
        prev,
        this.hazardForCharacter(entity),
        this.dt,
        this.now(),
      );
      this.hazardStates.set(entity.playerId, state);
      if (knocked) {
        this.log.info('player knocked down (shield burn)', {
          playerId: entity.playerId,
          hazard: this.hazardForCharacter(entity),
        });
        this.events.emit('hazard-knockdown', { playerId: entity.playerId });
      }
    }
  }

  /**
   * TASK-48 step 2: one drone step. A killed drone first re-checks its
   * 180 s respawn timer (the tick is the timer — no setTimeout in the shard,
   * the rogue pattern); then each live drone aggroes the NEAREST on-foot
   * player within 80 m (ships/space traffic are never targets — the
   * surface-only threat), chases it, and fires for 3 (2 s cadence, ≤ 30 m)
   * through the shared damage pipeline with source {kind:'drone'}. With no
   * target it patrols a seeded orbit around its cell center.
   */
  private stepDrones(): void {
    const now = this.now();
    for (const [id, drone] of this.drones) {
      if (drone.respawnAtMs === undefined || now < drone.respawnAtMs) continue;
      const entity = this.entities.get(id);
      drone.respawnAtMs = undefined;
      if (!entity || !entity.destroyed) continue;
      entity.destroyed = false;
      entity.hull = 1;
      drone.hullPoints = DRONE_HULL;
      entity.ship.pos = { ...drone.spawnPos };
      entity.ship.vel = { x: 0, y: 0, z: 0 };
      this.log.debug('drone respawn', { id });
    }
    for (const [id, drone] of this.drones) {
      const entity = this.entities.get(id);
      if (!entity || entity.destroyed) continue;
      let target: SimEntity | undefined;
      let targetD = DRONE_AGGRO_RADIUS_M;
      for (const e of this.entities.values()) {
        if (e.kind !== 'character' || e.destroyed) continue;
        const d = vecLength(vecSub(entity.ship.pos, e.ship.pos));
        if (d <= targetD) {
          targetD = d;
          target = e;
        }
      }
      if (target) {
        const to = vecSub(target.ship.pos, entity.ship.pos);
        const d = vecLength(to);
        if (d > 0.001) {
          const step = Math.min(DRONE_CHASE_SPEED * this.dt, d);
          entity.ship.pos = vecAdd(entity.ship.pos, vecScale(to, step / d));
        }
        entity.ship.vel = { x: 0, y: 0, z: 0 };
        if (d <= DRONE_FIRE_RADIUS_M && now >= drone.nextFireAtMs) {
          drone.nextFireAtMs = now + DRONE_FIRE_INTERVAL_MS;
          this.droneFire(id, target);
        }
      } else {
        // Patrol: circle the cell center, hovering above the LOCAL ground at
        // the orbit point — the cell-CENTER height would sit the drone tens
        // of metres below a hilly orbit and out of the 80 m aggro radius.
        // planetHeightAt is the pure O(1) field (cache-free per call), so it
        // costs nothing per tick (the TerrainContext heightAt would re-prime
        // its 3×3 chunk cache and stall the sim).
        drone.orbitAngle += drone.orbitDir * DRONE_ORBIT_SPEED * this.dt;
        const ox = drone.cell.x + Math.cos(drone.orbitAngle) * drone.orbitRadius;
        const oz = drone.cell.z + Math.sin(drone.orbitAngle) * drone.orbitRadius;
        const planet = this.system.planets.find((p) => p.id === drone.planetId);
        const heightAt = planet ? this.localHeightAt(planet) : undefined;
        const y = (heightAt ? heightAt(ox, oz) : drone.cell.y) + DRONE_HOVER_M;
        entity.ship.pos = { x: ox, y, z: oz };
        entity.ship.vel = { x: 0, y: 0, z: 0 };
      }
    }
  }

  /**
   * One drone attack (AC): 3 points through the SHARED damage pipeline with
   * source {kind:'drone'}, applied to the target's exposure pool (the
   * personal shield — the pool plays the shield slot of the pipeline). At 0
   * the player is knocked to 'recovering' (v1: NO on-foot death — the pool
   * is the entire on-foot risk; the ship is the stakes).
   */
  private droneFire(droneId: string, target: SimEntity): void {
    const playerId = target.playerId;
    if (!playerId) return;
    const now = this.now();
    const state = this.hazardStates.get(playerId) ?? FULL_EXPOSURE;
    if (now < state.recoveringUntilMs) return; // already down: no re-trigger
    const result = applyDamage({ hull: EXPOSURE_MAX, shields: state.exposure }, DRONE_HIT_DAMAGE, {
      kind: 'drone',
      id: droneId,
    });
    const consumed = result.shieldHit + result.hullHit;
    const exposure = Math.max(0, state.exposure - consumed);
    const knocked = consumed > 0 && exposure <= 0;
    this.hazardStates.set(
      playerId,
      knocked
        ? { exposure: 0, recoveringUntilMs: now + RECOVER_MS }
        : { exposure, recoveringUntilMs: 0 },
    );
    this.broadcastCombatEvent({
      kind: 'hit',
      target: target.id,
      source: { kind: 'drone', id: droneId },
      weapon: 'drone-cannon',
      damage: DRONE_HIT_DAMAGE,
      shieldHit: result.shieldHit,
      hullHit: result.hullHit,
    });
    if (knocked) this.log.info('drone knocked the player down', { playerId, drone: droneId });
  }

  /**
   * Spawn one drone of a seeded drone cell at its patrol position (a seeded
   * offset from the cell center — the SAME count the client derives, so a
   * client always sees exactly the cell's drones in the 10 Hz snapshot).
   * `rng` is the tick-0 shard RNG (draw order = spawn order, deterministic).
   */
  private spawnDroneEntity(hazard: Hazard, index: number, rng: () => number): void {
    const id = `drone:${hazard.hazardId}:${index}`;
    const orbitAngle = rng() * Math.PI * 2;
    const orbitRadius = hazard.radius * (0.3 + rng() * 0.4);
    const spawnPos: Vec3 = {
      x: hazard.pos.x + Math.cos(orbitAngle) * orbitRadius,
      y: hazard.pos.y + DRONE_HOVER_M,
      z: hazard.pos.z + Math.sin(orbitAngle) * orbitRadius,
    };
    this.entities.set(id, {
      id,
      kind: 'drone',
      playerId: null,
      classId: 'drone',
      ship: { pos: spawnPos, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'surface' },
      hull: 1,
      shields: 0,
      targetId: null,
      docked: false,
    });
    this.drones.set(id, {
      hazardId: hazard.hazardId,
      planetId: hazard.planetId,
      cell: hazard.pos,
      orbitRadius,
      orbitAngle,
      orbitDir: rng() < 0.5 ? 1 : -1,
      hullPoints: DRONE_HULL,
      nextFireAtMs: 0,
      spawnPos,
    });
  }

  /**
   * TASK-48: the per-connection hazard frame (10 Hz, on-foot players only).
   * The exposure pool is PRIVATE per-player state — like 'mining', it cannot
   * ride the shared entity_update buffer (the encode-once design must stay
   * byte-identical for every peer). The client's exposure meter reads it.
   */
  private sendHazardFrames(): void {
    for (const conn of this.connections.values()) {
      const character = this.entities.get(`char:${conn.playerId}`);
      if (!character) continue; // in-ship: no pool, no frame
      const state = this.hazardStates.get(conn.playerId) ?? FULL_EXPOSURE;
      const recoveringUntil =
        state.recoveringUntilMs > this.now() ? state.recoveringUntilMs : undefined;
      const payload = {
        exposure: Math.round(state.exposure * 100) / 100,
        inside: this.hazardForCharacter(character) ?? undefined,
        recoveringUntil,
      };
      const check = messageSchemas.hazard.safeParse(payload);
      if (!check.success) continue; // dev safety: never crash the dispatch
      conn.send(encodeMessage('hazard', check.data));
    }
  }

  /**
   * TASK-48 test hook: damage a drone through the SHARED pipeline (v1 has
   * no on-foot weapons, so the it/e2e damage it directly). A killing hit
   * despawns the drone (destroyed, hull 0 on the wire) and arms its 180 s
   * respawn timer.
   */
  damageDroneForTesting(entityId: string, amount: number): boolean {
    const drone = this.drones.get(entityId);
    const entity = this.entities.get(entityId);
    if (!drone || !entity || entity.destroyed) return false;
    const result = applyDamage({ hull: drone.hullPoints, shields: 0 }, amount, {
      kind: 'player',
      id: 'test',
    });
    drone.hullPoints = Math.max(0, drone.hullPoints - result.hullHit);
    entity.hull = drone.hullPoints / DRONE_HULL;
    if (result.destroyed) {
      entity.destroyed = true;
      drone.respawnAtMs = this.now() + DRONE_RESPAWN_MS;
      this.broadcastCombatEvent({
        kind: 'destroyed',
        target: entityId,
        source: { kind: 'player', id: 'test' },
        weapon: 'test',
      });
      this.log.info('drone destroyed (test hook)', { drone: entityId });
    }
    return true;
  }

  /** TASK-48 test hook: set the player's exposure pool (integration assist). */
  setExposureForTesting(playerId: string, exposure: number): void {
    this.hazardStates.set(playerId, {
      exposure: Math.min(EXPOSURE_MAX, Math.max(0, exposure)),
      recoveringUntilMs: 0,
    });
  }

  /** TASK-48 test hook: read the player's hazard state (full when absent). */
  getHazardStateForTesting(playerId: string): ExposureState {
    return this.hazardStates.get(playerId) ?? FULL_EXPOSURE;
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
  addDepositForTesting(pos: Vec3, quantity = 1, resourceId: ResourceId = 'iron'): string {
    const id = `${DEPOSIT_ENTITY_PREFIX}dev${++this.devDepositSeq}`;
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
      // TASK-38: mining awards the deposit's resource — a dev deposit always
      // has one (the client's '+1 <resource>' float + prompt use it).
      resourceId,
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
    this.entities.set(`${DEPOSIT_ENTITY_PREFIX}${deposit.depositId}`, {
      id: `${DEPOSIT_ENTITY_PREFIX}${deposit.depositId}`,
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
   * TASK-40: spawn the static entity for one derived station terminal
   * (one per pad, at the pad edge — terminalsFor). Same static shape as the
   * deposit entities; the sell flow's proximity check runs against the
   * positions of these entities (server validates, TASK-40 AC).
   */
  private spawnTerminalEntity(terminal: TerminalInfo): void {
    this.entities.set(terminal.terminalId, {
      id: terminal.terminalId,
      kind: 'terminal',
      playerId: null,
      classId: 'terminal',
      ship: {
        pos: { ...terminal.pos },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      planetId: terminal.planetId,
    });
  }

  /**
   * TASK-45: spawn one rogue AI ship from its seeded roster entry — full
   * hull/shields (normalized 1: applyHit scales by the class caps), space
   * regime, velocity zero, at the spawnPos, with the seeded pirate livery.
   * The wire id IS the roster aiId (stable per system), and the roster
   * record is what the tick's respawn sweep resets in place.
   */
  private spawnRogueShip(entry: RogueRosterEntry): void {
    this.entities.set(entry.aiId, {
      id: entry.aiId,
      kind: 'ai-ship',
      playerId: null,
      callsign: entry.callsign,
      classId: entry.classId,
      ship: {
        pos: { ...entry.spawnPos },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'space',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      livery: { ...entry.livery },
      docked: false,
      energy: ENERGY_MAX,
    });
    this.rogues.set(entry.aiId, { ...entry, respawnAtMs: undefined });
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
        (p) => vecLength(vecSub(entity.ship.pos, p)) <= DEPOSIT_DISCOVERY_RADIUS_M,
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
   * Dev/test hook (TASK-40 e2e teleport-assist): hard-set the player's ON-FOOT
   * character position (id `char:<playerId>`). Needed because the station
   * terminal sits at the pad edge (PAD_RADIUS_M from the docked ship), far
   * beyond the disembark spawn offset — the e2e walks the character straight
   * to the terminal instead of simulating the walk. Returns false when the
   * player has no on-foot character in this shard.
   */
  teleportCharacterForTesting(playerId: string, pos: Vec3): boolean {
    const character = this.entities.get(`char:${playerId}`);
    if (!character || character.kind !== 'character') return false;
    character.ship.pos = { ...pos };
    character.ship.vel = { x: 0, y: 0, z: 0 };
    this.log.debug('character teleport (dev/test hook)', {
      playerId,
      x: pos.x,
      y: pos.y,
      z: pos.z,
    });
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
   * TASK-39: the player's cargo hold (an EMPTY one for a class whose cargo
   * field is somehow absent — pre-39 entities; a real ship entity always
   * carries one after entityFromShipRow/adoptEntity).
   */
  private holdOf(ship: SimEntity): CargoHold {
    return ship.cargo ?? (ship.cargo = emptyCargoHold(ship.classId));
  }

  /**
   * TASK-39: open the cargo panel — the server answers the REQUESTING
   * connection (stale-conn guarded) with a 'cargo' frame:
   * - in the ship (the HUD 'Cargo' button — in flight OR docked): the hold
   *   ONLY (no inventory side: transfers require being on foot at the ship);
   * - on foot (the '[E] Open cargo' prompt): the hold AND the inventory,
   *   but only for a PAD-DOCKED own ship within 5 m (the same reach as the
   *   enter-ship prompt — the one that can also transfer).
   * Validation order mirrors handleEnterShip: own ship (implicit — the
   * payload carries no shipId: one ship per player, v1 invariant), docked,
   * range.
   */
  handleCargoOpen(playerId: string, source?: unknown): CargoOpenOutcome {
    const ship = this.playerEntities.get(playerId);
    if (!ship || ship.kind !== 'ship') {
      this.sendErrorToPlayer(playerId, 'unknown-ship', 'you have no ship', source);
      return 'unknown-ship';
    }
    const character = this.entities.get(`char:${playerId}`);
    if (character) {
      if (!ship.padId) {
        this.sendErrorToPlayer(
          playerId,
          'not-docked',
          'ship is not docked on a landing pad',
          source,
        );
        return 'not-docked';
      }
      if (vecLength(vecSub(ship.ship.pos, character.ship.pos)) > ENTER_SHIP_RANGE_M) {
        this.sendErrorToPlayer(playerId, 'out-of-range', 'the ship is out of reach', source);
        return 'out-of-range';
      }
      this.sendCargo(playerId, this.holdOf(ship), ship.inventory ?? emptyInventory(), source);
    } else {
      // In the ship: the hold only (the AC's "no inventory side while in
      // flight" — the panel is read-only until you are on foot at the ship).
      this.sendCargo(playerId, this.holdOf(ship), undefined, source);
    }
    return 'ok';
  }

  /**
   * TASK-39: move units between the on-foot inventory and the cargo hold
   * (the haul leg: mine → LOAD here → fly → sell from the hold, TASK-40).
   * Validation order — each failure answers the REQUESTING connection with
   * a structured error (stale-conn guarded, like handleEnterShip):
   * 1. on foot (transfers happen AT the dock, not in the cockpit);
   * 2. own ship exists (implicit: the player's own ship — no one else's
   *    hold is ever reachable);
   * 3. the ship is PAD-DOCKED;
   * 4. the character is within 5 m (ENTER_SHIP_RANGE_M, the ship's reach);
   * 5. known resource + positive integer amount.
   * Then the shared atomic transfer math (@shared/cargo.transferCargo):
   * `from: 'inv'` loads into the hold (bounded by what is owned AND the
   * hold's remaining weight — PARTIAL when the hold nears its cap),
   * `from: 'hold'` unloads into the weight-capped inventory. Both stacks
   * are applied in one step; moved 0 (nothing owned, or no space) is a
   * structured 'insufficient' denial. Success answers the requester with
   * the new 'cargo' frame (the panel re-renders); persistence rides the
   * next shard flush (ships.cargo — the TASK-24 cadence), and warp writes
   * it explicitly (router).
   */
  handleCargoTransfer(
    playerId: string,
    payload: { resourceId: string; amount: number; from: 'inv' | 'hold' },
    source?: unknown,
  ): CargoTransferOutcome {
    const character = this.entities.get(`char:${playerId}`);
    if (!character) {
      this.sendErrorToPlayer(
        playerId,
        'wrong-regime',
        'cargo transfers require being on foot at the ship',
        source,
      );
      return 'wrong-regime';
    }
    const ship = this.playerEntities.get(playerId);
    if (!ship || ship.kind !== 'ship') {
      this.sendErrorToPlayer(playerId, 'unknown-ship', 'you have no ship', source);
      return 'unknown-ship';
    }
    if (!ship.padId) {
      this.sendErrorToPlayer(playerId, 'not-docked', 'ship is not docked on a landing pad', source);
      return 'not-docked';
    }
    if (vecLength(vecSub(ship.ship.pos, character.ship.pos)) > ENTER_SHIP_RANGE_M) {
      this.sendErrorToPlayer(playerId, 'out-of-range', 'the ship is out of reach', source);
      return 'out-of-range';
    }
    if (!isResourceId(payload.resourceId)) {
      this.sendErrorToPlayer(
        playerId,
        'invalid-resource',
        `unknown resource ${payload.resourceId}`,
        source,
      );
      return 'invalid-resource';
    }
    if (!Number.isInteger(payload.amount) || payload.amount <= 0) {
      this.sendErrorToPlayer(
        playerId,
        'invalid-amount',
        'amount must be a positive integer',
        source,
      );
      return 'invalid-amount';
    }
    const res = transferCargo(
      this.holdOf(ship),
      ship.inventory ?? emptyInventory(),
      payload.resourceId,
      payload.amount,
      payload.from,
    );
    if (res.moved === 0) {
      this.sendErrorToPlayer(
        playerId,
        'insufficient',
        'nothing to move — no units owned or no weight space in the destination',
        source,
      );
      return 'insufficient';
    }
    // One atomic apply: both stacks replaced (never mutated), the character
    // mirror follows the inventory (the client's weight bar reads the self
    // entity), and the requester gets the fresh 'cargo' frame.
    ship.cargo = res.hold;
    ship.inventory = res.inv;
    this.syncCharacterInventory(playerId);
    this.log.info('cargo transferred', {
      playerId,
      resource: payload.resourceId,
      from: payload.from,
      moved: res.moved,
      remaining: res.remaining,
      hold: res.hold.weightUsed,
      capacity: res.hold.capacity,
    });
    this.events.emit('cargo-transfer', {
      playerId,
      resource: payload.resourceId,
      from: payload.from,
      moved: res.moved,
      remaining: res.remaining,
    });
    this.sendCargo(playerId, res.hold, res.inv, source);
    return 'ok';
  }

  /**
   * TASK-39: the 'cargo' frame — server → the requesting connection ONLY
   * (the panel is a per-player view, like 'ui-open'). The hold is always;
   * the inventory only when `inventory` is given (on-foot prompt).
   * Validated against the wire contract before it goes out (a failing
   * frame must never crash the dispatch, mirroring the snapshot path).
   */
  private sendCargo(
    playerId: string,
    hold: CargoHold,
    inventory: InventoryStacks | undefined,
    source?: unknown,
  ): void {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return;
    if (source !== undefined && conn.source !== source) return;
    const payload = {
      hold: { stacks: hold.stacks, weightUsed: hold.weightUsed, capacity: hold.capacity },
      ...(inventory !== undefined ? { inventory: toPlayerInventory(inventory) } : {}),
    } satisfies PayloadSchemas['cargo'];
    const check = messageSchemas['cargo'].safeParse(payload);
    if (!check.success) {
      this.log.warn('cargo frame failed wire validation', {
        issue: check.error.issues[0]?.message,
      });
      return;
    }
    conn.send(encodeMessage('cargo', check.data));
  }

  /**
   * TASK-40: horizontal (xz) distance to the NEAREST station terminal (m).
   * Infinity when the shard has none (a system without landable planets).
   * The pad disc is flat, so altitude is not part of the reach.
   */
  private nearestTerminalDistance(pos: Vec3): number {
    let best = Infinity;
    for (const e of this.entities.values()) {
      if (e.kind !== 'terminal') continue;
      const d = Math.hypot(e.ship.pos.x - pos.x, e.ship.pos.z - pos.z);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * TASK-40: sell `amount` units of `resourceId` to the dock — the closing
   * leg of the resource loop (mine → load → haul → SELL). The single handler
   * behind BOTH surfaces: the WS 'sell' frame (in-game terminal flow) and
   * POST /api/ships/sell (the route delegates here — "same handler" AC).
   *
   * Validation order — each failure answers the REQUESTING connection with a
   * structured error (stale-conn guarded, like handleCargoTransfer):
   * 1. own ship entity exists (implicit: one ship per player, v1);
   * 2. known resource + positive integer amount;
   * 3. STATION CHECK (the spec's position validation against station
   *    entities): the ship must be DOCKED (at a station pad — a docked ship
   *    is at its station) → else {code:'not-docked'}; for source 'inv' the
   *    player must be ON FOOT within 10 m (TERMINAL_RANGE_M) of a station
   *    terminal → else {code:'not-at-station'} (source 'hold' needs only
   *    the docked ship — in-ship selling requires docked);
   * 4. the source fully funds the request → else {code:'insufficient'}
   *    (partial sells are not the dock's job: the UI offers Sell 1/All).
   * On success the shared pure sellFrom math produces the NEW stacks and
   * the earned credits, and ONE database transaction commits them together
   * (updateShipCargo/updatePlayerInventory + addCredits — atomicity AC: a
   * failed credit write rolls the stack back, and vice versa). The in-memory
   * entity is then applied (stacks + character mirror), a 'sold' event
   * fires, and the requester gets the 'sell' result frame (new stacks ride
   * it: the dock panel re-renders and the credits counter updates within
   * one frame — the '+N cr' float).
   */
  async handleSell(
    playerId: string,
    payload: { resourceId: string; amount: number; source: SellSource },
    source?: unknown,
  ): Promise<
    { ok: true; sold: number; earned: number; balance: number } | { ok: false; code: SellErrorCode }
  > {
    const ship = this.playerEntities.get(playerId);
    if (!ship || ship.kind !== 'ship') {
      this.sendErrorToPlayer(playerId, 'unknown-ship', 'you have no ship', source);
      return { ok: false, code: 'unknown-ship' };
    }
    if (!isResourceId(payload.resourceId)) {
      this.sendErrorToPlayer(
        playerId,
        'invalid-resource',
        `unknown resource ${payload.resourceId}`,
        source,
      );
      return { ok: false, code: 'invalid-resource' };
    }
    if (!Number.isInteger(payload.amount) || payload.amount <= 0) {
      this.sendErrorToPlayer(
        playerId,
        'invalid-amount',
        'amount must be a positive integer',
        source,
      );
      return { ok: false, code: 'invalid-amount' };
    }
    // The station check: a docked ship is AT its station (pad or dock plane).
    if (!ship.docked && !ship.padId) {
      this.sendErrorToPlayer(
        playerId,
        'not-docked',
        'the ship must be docked at the station to sell',
        source,
      );
      return { ok: false, code: 'not-docked' };
    }
    if (payload.source === 'inv') {
      const character = this.entities.get(`char:${playerId}`);
      if (!character || this.nearestTerminalDistance(character.ship.pos) > TERMINAL_RANGE_M) {
        this.sendErrorToPlayer(
          playerId,
          'not-at-station',
          `selling from your inventory requires standing within ${TERMINAL_RANGE_M} m of a station terminal`,
          source,
        );
        return { ok: false, code: 'not-at-station' };
      }
    }
    const res = sellFrom(
      this.holdOf(ship),
      ship.inventory ?? emptyInventory(),
      payload.resourceId,
      payload.amount,
      payload.source,
    );
    if (!res.ok) {
      // resource/amount were validated above: this point is only reachable
      // as 'insufficient' (the other two codes are impossible here).
      const available = res.code === 'insufficient' ? res.available : 0;
      this.sendErrorToPlayer(
        playerId,
        'insufficient',
        `you can only sell ${available} ${payload.resourceId} from that source`,
        source,
      );
      return { ok: false, code: 'insufficient' };
    }
    // One transaction: the source stack decrement + the credit grant commit
    // TOGETHER (atomicity AC — the rollback test exercises this path).
    // Const captures: the typeof guards below narrow the CLOSURE too.
    const repo = this.repo;
    const updateShipCargo = repo.updateShipCargo;
    const updatePlayerInventory = repo.updatePlayerInventory;
    if (
      typeof repo.withTransaction !== 'function' ||
      typeof repo.addCredits !== 'function' ||
      (payload.source === 'hold' && typeof updateShipCargo !== 'function') ||
      (payload.source === 'inv' && typeof updatePlayerInventory !== 'function')
    ) {
      this.sendErrorToPlayer(
        playerId,
        'sell-failed',
        'the dock could not complete the sale',
        source,
      );
      return { ok: false, code: 'sell-failed' };
    }
    // TASK-67 (abuse finding): the in-memory step is applied SYNCHRONOUSLY,
    // BEFORE the commit is awaited. Applying AFTER the await let a second sell
    // on the same socket read the PRE-SELL stacks while the first commit was
    // still in flight, so 100 sells paid out units that were only removed once
    // (credits duplicated). Apply first, restore on a failed commit.
    const prevCargo = ship.cargo;
    const prevInventory = ship.inventory;
    ship.cargo = res.hold;
    ship.inventory = res.inv;
    this.syncCharacterInventory(playerId);
    let balance: number;
    try {
      balance = await repo.withTransaction(async (tx) => {
        // The source-specific writer is guarded above (and TS does not carry
        // that narrowing into the closure) — re-check in-branch before use.
        if (payload.source === 'hold') {
          if (typeof updateShipCargo !== 'function') throw new Error('missing updateShipCargo');
          await updateShipCargo(ship.id, res.hold.stacks);
        } else {
          if (typeof updatePlayerInventory !== 'function') {
            throw new Error('missing updatePlayerInventory');
          }
          await updatePlayerInventory(playerId, res.inv);
        }
        const row = await tx.addCredits(playerId, res.earned);
        return row.credits;
      });
    } catch (err) {
      // A failed commit rolled EVERYTHING back (stacks AND credits) — the
      // in-memory stacks are restored to exactly what they were and the
      // denial answers the requester.
      ship.cargo = prevCargo;
      ship.inventory = prevInventory;
      this.syncCharacterInventory(playerId);
      this.log.warn('sell transaction failed', {
        playerId,
        resource: payload.resourceId,
        error: String(err),
      });
      this.sendErrorToPlayer(
        playerId,
        'sell-failed',
        'the dock could not complete the sale',
        source,
      );
      return { ok: false, code: 'sell-failed' };
    }
    // Committed: the stacks were already applied synchronously above (the
    // pre-image is dropped), the 'sell' result frame answers the requester.
    this.log.info('cargo sold to the dock', {
      playerId,
      resource: payload.resourceId,
      source: payload.source,
      sold: res.sold,
      earned: res.earned,
      balance,
    });
    this.events.emit('sold', {
      playerId,
      resource: payload.resourceId,
      source: payload.source,
      sold: res.sold,
      earned: res.earned,
      balance,
    });
    this.sendSellResult(
      playerId,
      payload.resourceId,
      res.sold,
      res.earned,
      balance,
      res.hold,
      res.inv,
      source,
    );
    return { ok: true, sold: res.sold, earned: res.earned, balance };
  }

  /**
   * TASK-40: the 'sell' result frame — server → the requesting connection
   * ONLY (like 'cargo' / 'ui-open'): {resourceId, sold, earned, balance,
   * hold, inventory} — the NEW stacks ride the frame so the dock panel
   * re-renders (the source stack decreases) and the credits counter updates
   * within one frame (the '+N cr' float). Validated against the wire
   * contract before it goes out (a failing frame must never crash the
   * dispatch, mirroring the snapshot path).
   */
  private sendSellResult(
    playerId: string,
    resourceId: string,
    sold: number,
    earned: number,
    balance: number,
    hold: CargoHold,
    inv: InventoryStacks,
    source?: unknown,
  ): void {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return;
    if (source !== undefined && conn.source !== source) return;
    const payload = {
      resourceId,
      sold,
      earned,
      balance,
      hold: { stacks: hold.stacks, weightUsed: hold.weightUsed, capacity: hold.capacity },
      inventory: toPlayerInventory(inv),
    } satisfies PayloadSchemas['sell'];
    const check = messageSchemas['sell'].safeParse(payload);
    if (!check.success) {
      this.log.warn('sell frame failed wire validation', {
        issue: check.error.issues[0]?.message,
      });
      return;
    }
    conn.send(encodeMessage('sell', check.data));
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
   * - 'deposit'  → the hold-to-mine channel (TASK-38): 'mine-start' (or a
   *                legacy 'pickup' / absent action) starts it, 'mine-stop'
   *                cancels it — the TICK advances it (1.5 s per unit,
   *                weight-cap pause, depletion despawn);
   * - 'terminal' → a 'ui-open' {ui:'dock'} frame to the requester (the dock
   *                UI that consumes it lands in TASK-40/53);
   * - 'ship'     → 'open-cargo' (TASK-39, the far-zone '[E] Open cargo'
   *                prompt) opens the panel via handleCargoOpen (ownership
   *                checked here — the interact path targets a SHIP entity,
   *                which may not be the player's own); any other action
   *                delegates to handleEnterShip (TASK-35) — the same effect
   *                and validation as the dedicated 'enter_ship' message, so
   *                a legacy interact frame and the new one can never diverge.
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
    // TASK-48: a recovering player (SHIELD BURN knock-down) cannot interact
    // for the whole 5 s window — same freeze as the movement inputs.
    if ((this.hazardStates.get(playerId)?.recoveringUntilMs ?? 0) > this.now()) {
      this.sendErrorToPlayer(playerId, 'recovering', 'shield burn: recovering', source);
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
        return this.handleMine(playerId, target, action, source);
      case 'terminal':
        this.sendUiOpen(playerId, target.id, source);
        return 'ok';
      case 'ship':
        if (action === 'open-cargo') {
          // TASK-39: the far-zone '[E] Open cargo' prompt. Ownership first
          // (the raycast pre-filters own-ship already, the server stays the
          // authority), then the shared open path (docked + 5 m + the
          // 'cargo' frame).
          if (target.playerId !== playerId) {
            this.sendErrorToPlayer(
              playerId,
              'not-owner',
              'that ship belongs to another pilot',
              source,
            );
            return 'not-owner';
          }
          return this.handleCargoOpen(playerId, source);
        }
        // TASK-35: re-entry — delegate to the dedicated handler (ownership,
        // 5 m range, speed cap, idempotency). Same effect as the 'enter_ship'
        // message; one handler owns the state change.
        return this.handleEnterShip(playerId, targetId, source);
    }
  }

  /**
   * TASK-38: the hold-to-mine deposit flow (replaces the v1 tap pickup —
   * "hold, not tap": the 1.5 s channel is the only deposit effect):
   * - 'mine-start' / 'mine-tick' (and a legacy 'pickup' / absent action,
   *   for back-compat) → ensure a channel on the target deposit: it STARTS
   *   when none is active, is an idempotent no-op on the same deposit
   *   (re-asserted intent), and SWITCHES (cancelling the old channel) when
   *   the target changed;
   * - 'mine-stop' → end the channel ('stopped' — a cancel: the in-flight
   *   unit is NOT awarded);
   * - any other action on a deposit is a structured denial.
   * The handler only manages channel STATE — the TICK (updateMining) is the
   * award authority: units land on the server's 1.5 s cadence, so a client
   * can spam any of these messages and gain nothing extra (anti-spam AC).
   * A fresh channel gets an immediate progress-0 echo so the ring appears
   * without waiting for the next 10 Hz cadence.
   */
  private handleMine(
    playerId: string,
    target: SimEntity,
    action: string | undefined,
    source?: unknown,
  ): InteractOutcome {
    if (action === 'mine-stop') {
      const channel = this.mining.get(playerId);
      if (channel && channel.depositId === target.id) {
        this.mining.delete(playerId);
        this.log.info('mining stopped (E released)', {
          playerId,
          deposit: target.id,
          units: channel.unitsSoFar,
        });
        this.sendMiningEnd(playerId, target.id, 'stopped', channel.unitsSoFar);
      }
      return 'ok';
    }
    if (
      action !== undefined &&
      action !== 'mine-start' &&
      action !== 'mine-tick' &&
      action !== 'pickup'
    ) {
      this.sendErrorToPlayer(
        playerId,
        'invalid-action',
        `deposits are mined by holding E (got '${action ?? ''}')`,
        source,
      );
      return 'invalid-action';
    }
    if (!target.resourceId || !isResourceId(target.resourceId)) {
      this.sendErrorToPlayer(
        playerId,
        'invalid-resource',
        'the deposit has no known resource',
        source,
      );
      return 'invalid-resource';
    }
    const existing = this.mining.get(playerId);
    if (existing && existing.depositId !== target.id) {
      // The player aimed at a different deposit: the old channel cancels
      // (no in-flight unit awarded) and the new one starts fresh.
      this.mining.delete(playerId);
      this.log.info('mining switched deposit', {
        playerId,
        from: existing.depositId,
        to: target.id,
      });
      this.sendMiningEnd(playerId, existing.depositId, 'cancelled', existing.unitsSoFar);
    }
    if (!existing || existing.depositId !== target.id) {
      this.mining.set(playerId, {
        depositId: target.id,
        unitsSoFar: 0,
        lastAwardAt: this.now(),
      });
      this.log.info('mining started', {
        playerId,
        deposit: target.id,
        resource: target.resourceId,
      });
      this.sendMiningActive(playerId, target.id, 0, 0, 'mining');
    }
    return 'ok';
  }

  /**
   * TASK-38: advance EVERY active mining channel by one tick (the single
   * award path — client messages can never grant):
   * - the server clock is the truth: a unit is awarded exactly when
   *   `now − lastAwardAt ≥ MINING_UNIT_MS` (the shared stepMiningChannel
   *   math; spamming mine-tick changes nothing — anti-spam AC);
   * - each award is the atomic pair deposit.remaining −1 / inventory +1
   *   (weight-capped via the shared pickup math), the seed row persisted
   *   (TASK-37 lazy upsert), and a 'mine' event emitted;
   * - at the weight cap the channel PAUSES ('full' status, the due award is
   *   HELD — lastAwardAt is not advanced — and lands on the next tick once
   *   space frees);
   * - cancellation: walking > 3 m (checked per tick) or the character being
   *   gone (re-entry) ends the channel ('cancelled', NO unit awarded);
   * - depletion: at zero remaining the deposit despawns for ALL clients
   *   (it leaves the next 10 Hz snapshot; the seed row stays at 0) and the
   *   channel ends cleanly ('depleted' — the mid-channel 'Depleted' prompt);
   * - every 2nd tick (10 Hz) the miner's CURRENT connection gets the
   *   progress echo (per-connection frame: the shared entity_update buffer
   *   must stay byte-identical for every peer — the TASK-14 ack precedent).
   */
  private updateMining(tick: number): void {
    if (this.mining.size === 0) return;
    const now = this.now();
    for (const [playerId, channel] of this.mining) {
      const character = this.entities.get(`char:${playerId}`);
      if (!character) {
        // Re-entered the ship (or fully gone): the channel dies with it.
        this.mining.delete(playerId);
        this.sendMiningEnd(playerId, channel.depositId, 'cancelled', channel.unitsSoFar);
        continue;
      }
      const deposit = this.entities.get(channel.depositId);
      if (!deposit || deposit.kind !== 'deposit') {
        // The deposit is gone — deposits despawn ONLY at zero remaining.
        this.mining.delete(playerId);
        this.sendMiningEnd(playerId, channel.depositId, 'depleted', channel.unitsSoFar);
        continue;
      }
      if (vecLength(vecSub(deposit.ship.pos, character.ship.pos)) > INTERACT_RANGE_M) {
        // Walked > 3 m: the channel cancels (no unit awarded on cancel).
        this.mining.delete(playerId);
        this.log.info('mining cancelled (out of range)', {
          playerId,
          deposit: deposit.id,
          units: channel.unitsSoFar,
        });
        this.sendMiningEnd(playerId, deposit.id, 'cancelled', channel.unitsSoFar);
        continue;
      }
      const step = stepMiningChannel(
        channel,
        now,
        deposit.quantity ?? 0,
        this.getInventory(playerId),
        (deposit.resourceId ?? 'iron') as ResourceId,
      );
      let full = false;
      if (step.kind === 'awarded') {
        // The atomic award: inventory +1 (weight-capped) and deposit −1.
        const player = this.playerEntities.get(playerId);
        if (player) {
          player.inventory = step.stacks;
          this.syncCharacterInventory(playerId);
        }
        channel.unitsSoFar += 1;
        channel.lastAwardAt = now;
        const left = (deposit.quantity ?? 1) - 1;
        if (left <= 0) {
          // Depleted: despawn for everyone, the seed row stays at 0 (TASK-37).
          if (deposit.depositSeq !== undefined) {
            deposit.quantity = 0;
            deposit.depositDiscovered = true;
            this.persistDeposit(deposit);
          }
          this.entities.delete(deposit.id);
          this.log.info('deposit depleted', { playerId, deposit: deposit.id });
          this.mining.delete(playerId);
          this.sendMiningEnd(playerId, deposit.id, 'depleted', channel.unitsSoFar);
          this.events.emit('mine', {
            playerId,
            depositId: deposit.id,
            resource: deposit.resourceId,
            remaining: 0,
            units: channel.unitsSoFar,
          });
          continue;
        }
        deposit.quantity = left;
        // Seed deposits persist on every mine (row created lazily on the
        // FIRST mine; upsert after). Dev-hook deposits stay in-memory.
        if (deposit.depositSeq !== undefined) {
          deposit.depositDiscovered = true; // a mine happened at < 3 m
          this.persistDeposit(deposit);
        }
        this.log.info('mining unit awarded', {
          playerId,
          deposit: deposit.id,
          resource: deposit.resourceId,
          remaining: left,
          units: channel.unitsSoFar,
        });
        this.events.emit('mine', {
          playerId,
          depositId: deposit.id,
          resource: deposit.resourceId,
          remaining: left,
          units: channel.unitsSoFar,
        });
      } else if (step.kind === 'full') {
        // At the weight cap: PAUSED — lastAwardAt is NOT advanced, so the
        // due award lands on the next tick once space frees.
        full = true;
      }
      // 10 Hz progress echo to the miner (the client UI is server-timed).
      if (tick % SNAPSHOT_EVERY_TICKS === 0) {
        const progress = Math.min(1, (now - channel.lastAwardAt) / MINING_UNIT_MS);
        this.sendMiningActive(
          playerId,
          deposit.id,
          progress,
          channel.unitsSoFar,
          full ? 'full' : 'mining',
        );
      }
    }
  }

  /**
   * TASK-38: a 'mining' frame to the miner's CURRENT connection (stale-conn
   * guarded, like the errors; wire-validated — a failing frame must never
   * crash the tick). Server → ONE client only (the channel is private view).
   */
  private sendMining(playerId: string, frame: PayloadSchemas['mining']): void {
    const connId = this.playerConns.get(playerId);
    const conn = connId ? this.connections.get(connId) : undefined;
    if (!conn) return;
    const check = messageSchemas.mining.safeParse(frame);
    if (!check.success) {
      this.log.warn('mining frame failed wire validation', {
        issue: check.error.issues[0]?.message,
      });
      return;
    }
    conn.send(encodeMessage('mining', check.data));
  }

  private sendMiningActive(
    playerId: string,
    depositId: string,
    progress: number,
    units: number,
    status: 'mining' | 'full',
  ): void {
    this.sendMining(playerId, { phase: 'active', depositId, progress, units, status });
  }

  private sendMiningEnd(
    playerId: string,
    depositId: string,
    reason: 'stopped' | 'cancelled' | 'depleted',
    units: number,
  ): void {
    this.sendMining(playerId, { phase: 'ended', depositId, reason, units });
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
   * TASK-39: the player's cargo hold (lives on the PLAYER's ship entity —
   * the ship's cargo, NOT the player's inventory). The router reads this on
   * a warp: the in-memory hold is the authority (the DB row may be up to
   * one flush period stale). Undefined for a player with no ship entity.
   */
  getCargo(playerId: string): CargoHold | undefined {
    return this.playerEntities.get(playerId)?.cargo;
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
    // TASK-40: the dock Sell tab opens fully populated — the ship's hold + the
    // player's on-foot inventory ride the frame (the server's authority at
    // open time). The terminal sits at the pad edge, FAR from the docked ship,
    // so the cargo panel's 5 m reach does not apply here; the frame is the
    // panel's initial state (a later 'sell' result frame re-fills it).
    const ship = this.playerEntities.get(playerId);
    const dockState = ship
      ? (() => {
          const hold = this.holdOf(ship);
          return {
            hold: { stacks: hold.stacks, weightUsed: hold.weightUsed, capacity: hold.capacity },
            inventory: toPlayerInventory(ship.inventory ?? emptyInventory()),
          };
        })()
      : {};
    const payload = {
      ui: 'dock',
      payload: { terminalId, ...dockState },
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
   * TASK-48: a persistent, memoized heightAt for one planet (the drone-hover
   * path). Lazily built once per planet and cached for the shard's life —
   * see the `heightSamplers` field note for why it can't be the TerrainContext
   * or a per-call `planetHeightAt`.
   */
  private localHeightAt(planet: Planet): (x: number, z: number) => number {
    let h = this.heightSamplers.get(planet.id);
    if (!h) {
      h = planetHeightSampler(this.galaxySeed, planet);
      this.heightSamplers.set(planet.id, h);
    }
    return h;
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
      // TASK-39: the cargo hold rehydrates WITH the ship (ships.cargo JSON —
      // the raw row field, parsed + sanitized in one place; corrupt/missing
      // rows start empty, never wedge the shard).
      cargo: toCargoHold(parseCargoJson(ship.cargo), ship.classId),
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
      const entity = this.entities.get(`${DEPOSIT_ENTITY_PREFIX}${row.depositId}`);
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
  async loadShips(
    load: ShipsLoad,
  ): Promise<{ ships: number; wrecks: number; depositDeltas: number }> {
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
 * union (TASK-35). The 'deposit' branch runs the TASK-38 hold-to-mine
 * channel: 'invalid-action' (an action the channel does not speak) and
 * 'invalid-resource' (a deposit without a known resource type).
 */
export type InteractOutcome =
  | 'ok'
  | 'not-found'
  | 'out-of-range'
  | 'wrong-regime'
  | 'invalid-action'
  | 'invalid-resource'
  | 'not-docked'
  | Exclude<EnterShipOutcome, 'ok' | 'out-of-range'>;

/** The outcome of a cargo-panel open request (TASK-39). */
export type CargoOpenOutcome = 'ok' | 'unknown-ship' | 'not-docked' | 'out-of-range';

/**
 * The outcome of a cargo-transfer request (TASK-39) — the full validation
 * ladder plus the two shared-math denials (unknown resource, bad amount,
 * nothing to move).
 */
export type CargoTransferOutcome =
  | 'ok'
  | 'unknown-ship'
  | 'not-docked'
  | 'out-of-range'
  | 'wrong-regime'
  | 'invalid-resource'
  | 'invalid-amount'
  | 'insufficient';

/** Entity → wire EntityState (hull/shields normalized 0..1, regime mapped). */
export function entityToState(e: SimEntity, targetedBy?: string[]): EntityState {
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
  // TASK-45: the rogue AI flag — the client marks these callsigns 'AI' in
  // the presence list (the presence ENTRY list stays player-only).
  if (e.kind === 'ai-ship') state.ai = true;
  // TASK-29: the docked landing pad id (entity_update.state = 'docked' {padId}).
  if (e.padId) state.padId = e.padId;
  // TASK-33: deposit remaining units — a pickup shows as a quantity change,
  // or a removal at zero, in every client's next snapshot. TASK-34:
  // ground items ride the same field (their units) + `resourceId`.
  if (e.quantity !== undefined) state.quantity = e.quantity;
  if (e.resourceId !== undefined) state.resourceId = e.resourceId;
  // TASK-42: the wreck's killer id — TASK-49 renders the skull marker
  // from it until the wreck despawns.
  if (e.kind === 'wreck' && e.killerId) state.killerId = e.killerId;
  // TASK-44: the lock icon — the players currently locking this ship
  // (omitted when nobody is; the 10 Hz snapshot clears it in one frame).
  if (targetedBy && targetedBy.length > 0) state.targetedBy = targetedBy;
  // TASK-43: the ship's energy (the weapon HUD's bar reads it from the
  // SELF entity_update); undefined on pre-43 entities — omitted.
  if (e.kind === 'ship' && e.playerId && e.energy !== undefined) state.energy = e.energy;
  // TASK-43: a missile tracer — hull 0 (it takes no damage), targetId is
  // the homing target (the client renders it as a small tracer).
  if (e.kind === 'projectile') {
    state.hull = 0;
    state.shields = 0;
  }
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
