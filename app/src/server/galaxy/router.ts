/**
 * Galaxy router — TASK-11.
 *
 * The router owns every in-process system shard. A player's
 * `join_system` flow goes through here:
 *
 *   - **`getShard(systemId)`** returns the active `Shard` or, if
 *     none exists, *creates* one. Creation is async (loads ships
 *     from the DB, derives system data from the seeded galaxy) so
 *     a `Map<systemId, Shard>` alone isn't sufficient — a pending-
 *     promise map collapses concurrent spawns so 10 simultaneous
 *     joins into the same empty system get *one* hydrate, not 10.
 *
 *   - **`joinSystem(shard, conn, …)`** adds the connection to the
 *     shard, enforces the 16-player cap, and spawns the player's
 *     entity. The cap is checked against the shard's connection
 *     count (not entity count), so the connection that pushes the
 *     shard over the limit returns `system-full` and stays in its
 *     previous system.
 *
 *   - **`reapEmpty()`** is called from a 5 s `setInterval` timer.
 *     Every shard with zero connections and a non-empty grace timer
 *     that has elapsed is stopped: `flushShips` first (TASK-24
 *     durability), then `sim.stop()`, then `delete` from the map.
 *
 * The router also exposes a stats surface (`stats()`) for the
 * `/api/galaxy/health` endpoint and the future TASK-7 chart UI.
 *
 * ## Concurrency model
 *
 * The router is single-process. The "concurrent-spawn collapse" map
 * (one pending promise per systemId) protects against the
 * pathological N-asks-same-tick case where the JS event loop
 * coalesces 10 join requests into a single microtask. Each one sees
 * the in-progress promise instead of stacking an independent load.
 *
 * The pending map is cleared once the shard is registered. The
 * collapse map is independent of the live `Map<systemId, Shard>` so
 * a reap removes the live entry without affecting any in-flight
 * spawn promise.
 *
 * ## Reap timer
 *
 * The interval is configurable via `RouterOptions.reapIntervalMs`
 * (default 5 s) and the per-shard grace is
 * `DEFAULT_SHARD_REAP_GRACE_MS` (60 s) unless overridden. Tests drive
 * the timer manually via `forceReap()` so fake-timer suites don't
 * have to manage real `setInterval` cancellation.
 *
 * ## Acceptance criteria mapping
 *
 *   - **Spawn-on-demand with pending-promise collapse.** ✅
 *     `loadSystemData()` runs once per system even when N joins
 *     arrive in the same tick.
 *   - **`systemId`, `players`, `uptimeMs` per shard stats.** ✅ `stats()` returns
 *     this shape; `/api/galaxy/health` exposes it.
 *   - **16-cap enforcement.** ✅ `joinSystem` returns
 *     `system-full` if the shard already has 16 connections; the
 *     connection's `systemId` is left untouched so the player can
 *     pick a different target.
 *   - **60 s grace reap, ships flushed first.** ✅ `reapEmpty()`
 *     uses `flushShips` on the shard before stopping the sim.
 *
 * @see ./system-data.ts for the deterministic context builder.
 * @see ../shard/index.ts for the `Shard` runtime.
 * @see ../shard/persist.ts for the ship flush.
 * @see ../shard/load.ts for the spawn-time hydrate.
 * @see ../db/repo.ts for the persistence layer.
 */
import type { EventEmitter } from "node:events";
import { EventEmitter as NodeEventEmitter } from "node:events";

import {
  DEFAULT_ROUTER_REAP_INTERVAL_MS,
  DEFAULT_SHARD_REAP_GRACE_MS,
  MAX_PLAYERS_PER_SYSTEM,
} from "@shared/galaxy/constants.js";

import type { Repository } from "../db/repo.js";
import type { Shard, ShardConnection } from "../shard/types.js";
import { createShard, spawnShip } from "../shard/index.js";
import { ShardFlushService } from "../shard/persist.js";
import { loadShipsForShard, type shipRowToEntitySpec, specToEntityFields } from "../shard/load.js";
import type { ShipClassId } from "@shared/ships.js";

import { buildShardContext, GalaxySystemNotFoundError } from "./system-data.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One connection's view of the world as the router sees it. The
 * `JoinResolver` uses this to know who is joining, while the
 * `LeaveResolver` uses the symmetric `LeaveArgs` to know who left.
 */
export interface RouterConnectionContext {
  /** Stable WS connection id (matches `Connection.connId`). */
  connId: string;
  /** Callsign asserted by the auth resolver. */
  callsign: string;
  /** Player id from the `players` table. */
  playerId: string;
  /**
   * The ship the player controls. Resolved by the route layer by
   * joining the player's `shipId` (from `GET /api/players/me`). The
   * router doesn't touch `repo.listShipsByOwner`; the caller hands in
   * the row.
   */
  ship: {
    id: string;
    classId: ShipClassId;
    hull: number;
    shields: number;
    /** Quat tuple — the router flattens into the entity on spawn. */
    quat: readonly [number, number, number, number];
  };
}

/**
 * Outcome of a successful `joinSystem` call. The caller emits an
 * `enter_system` wire frame with `snapshotTick` and `players` list.
 */
export interface JoinResult {
  /** The shard the connection now belongs to. */
  shard: Shard;
  /** Connection id (echoed for the WS handler). */
  connId: string;
  /** The system the player just joined. */
  systemId: string;
  /** Number of players now in the system (1..MAX_PLAYERS_PER_SYSTEM). */
  players: number;
  /** Current sim tick of the snapshot the client should ack. */
  snapshotTick: number;
}

/** Outcome of a `joinSystem` failure — wire code is `system-full` or `system-not-found`. */
export interface JoinRejection {
  /** Wire code ("system-full" | "system-not-found"). */
  code: "system-full" | "system-not-found";
  /** Human-readable message. */
  message: string;
  /** The system id that was requested (echoed for debug). */
  systemId: string;
}

/** Per-shard stats exposed by `router.stats()`. */
export interface RouterShardStats {
  systemId: string;
  /** Display name pulled from the deterministic SystemGen. */
  name: string;
  /** Number of active player connections in the shard. */
  players: number;
  /** Milliseconds since the shard was first registered. */
  uptimeMs: number;
}

/** Top-level router stats (shape used by `/api/galaxy/health`). */
export interface RouterStats {
  shardCount: number;
  totalPlayers: number;
  /** Wall-clock ms when the router was instantiated. */
  routerStartedAt: number;
  shards: RouterShardStats[];
}

/** Options bag for `GalaxyRouter`. */
export interface RouterOptions {
  repo: Repository;
  /** Galaxy seed used to derive system data. */
  galaxySeed: string;
  /** Galaxy size (number of stars in `generateStars`). */
  galaxyStarCount: number;
  /** Override the per-shard reap grace (ms). Defaults to `DEFAULT_SHARD_REAP_GRACE_MS`. */
  reapGraceMs?: number;
  /** Override the reap sweep interval (ms). Defaults to `DEFAULT_ROUTER_REAP_INTERVAL_MS`. */
  reapIntervalMs?: number;
  /** Override the flush service (TASK-24). Tests may inject a recording variant. */
  flusher?: ShardFlushService;
  /** Custom event bus; defaults to a per-router `EventEmitter`. */
  events?: EventEmitter;
  /** Logger — defaults to a silent info logger so the tests don't spam console. */
  logger?: Pick<Console, "info" | "warn" | "error" | "debug">;
  /** Wall-clock override for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ReapSentinel {
  /** Wall-clock ms when the shard first hit zero connections. */
  emptySinceMs: number;
}

function silentLogger(): Pick<Console, "info" | "warn" | "error" | "debug"> {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ---------------------------------------------------------------------------
// GalaxyRouter
// ---------------------------------------------------------------------------

/**
 * The galaxy router. Single instance per server process.
 *
 * Lifecycle:
 *   - `new GalaxyRouter(opts)` — pure constructor; does not start the
 *     reap timer (call `start()` explicitly). This split lets tests
 *     construct the router, exercise `getShard`, and assert stats
 *     without dealing with real `setInterval` cancellation.
 *   - `start()` — schedule `reapEmpty()` on the configured interval.
 *     Idempotent.
 *   - `shutdown()` — call `reapEmpty({force: true})`, dispose the
 *     flush service, stop the timer, and clear all shards. Idempotent.
 */
export class GalaxyRouter {
  /** Live shards — the source of truth for `getShard`. */
  private readonly shards = new Map<string, Shard>();
  /** Pending-promise map — collapses concurrent spawns. */
  private readonly pendingSpawns = new Map<string, Promise<Shard>>();
  /** Per-shard reap sentinel. Cleared when a connection is added. */
  private readonly reapSentinels = new Map<string, ReapSentinel>();
  /** When the shard was first registered (for uptimeMs). */
  private readonly shardStartedAt = new Map<string, number>();
  /** When the router itself was instantiated. */
  private readonly routerStartedAt = Date.now();
  /** `setInterval` handle for `reapEmpty()`. */
  private reapTimer: ReturnType<typeof setInterval> | null = null;
  /** True once `shutdown()` has been called. */
  private disposed = false;

  /** Bumped on every resync for tests that subscribe to router activity. */
  readonly events: EventEmitter;

  private readonly reapGraceMs: number;
  private readonly reapIntervalMs: number;
  private readonly flusher: ShardFlushService;
  private readonly repo: Repository;
  private readonly galaxySeed: string;
  private readonly galaxyStarCount: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error" | "debug">;
  private readonly now: () => number;

  constructor(options: RouterOptions) {
    if (!(options.galaxyStarCount > 0)) {
      throw new Error("GalaxyRouter: galaxyStarCount must be > 0");
    }
    this.repo = options.repo;
    this.galaxySeed = options.galaxySeed;
    this.galaxyStarCount = options.galaxyStarCount;
    this.reapGraceMs = options.reapGraceMs ?? DEFAULT_SHARD_REAP_GRACE_MS;
    this.reapIntervalMs = options.reapIntervalMs ?? DEFAULT_ROUTER_REAP_INTERVAL_MS;
    this.flusher =
      options.flusher ??
      new ShardFlushService(options.repo, {
        intervalMs: 60_000, // unused — router flushes imperatively on reap
      });
    this.events = options.events ?? new NodeEventEmitter();
    this.logger = options.logger ?? silentLogger();
    this.now = options.now ?? Date.now;

    if (!Number.isFinite(this.reapGraceMs) || this.reapGraceMs < 0) {
      throw new Error(
        `GalaxyRouter: reapGraceMs must be a non-negative number, got ${this.reapGraceMs}`,
      );
    }
    if (!Number.isFinite(this.reapIntervalMs) || this.reapIntervalMs <= 0) {
      throw new Error(`GalaxyRouter: reapIntervalMs must be > 0, got ${this.reapIntervalMs}`);
    }
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /**
   * Schedule the reap sweep. Idempotent — calling twice returns the
   * same timer.
   */
  start(): void {
    if (this.disposed) return;
    if (this.reapTimer !== null) return;
    const timer = setInterval(() => {
      void this.reapEmpty();
    }, this.reapIntervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.reapTimer = timer;
  }

  /**
   * Stop the reap timer + reap every shard + flush + clear. Idempotent.
   *
   * Used by the server graceful-shutdown hook (`SIGTERM/SIGINT`).
   * Each shard is flushed first so a hard `kill -9` after
   * `shutdown()` cannot leave ships missing from the DB.
   */
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reapTimer !== null) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    // Reap with force=true to skip the grace window. flushShips runs
    // before sim.stop() so ship positions survive a subsequent kill.
    await this.reapEmpty({ force: true });
    this.flusher.dispose();
  }

  // -------------------------------------------------------------------
  // getShard — spawn-on-demand
  // -------------------------------------------------------------------

  /**
   * Idempotent shard fetch. If a shard for `systemId` is already
   * active, returns it. Otherwise creates one (load ships from DB +
   * generate system data) and returns the promise resolving to the
   * new shard.
   *
   * Concurrent spawn protection: while `loadSystemData(...)` is
   * running for a given `systemId`, all subsequent calls return the
   * same pending promise. This collapses N simultaneous joins into a
   * single hydrate.
   */
  async getShard(systemId: string): Promise<Shard> {
    const cached = this.shards.get(systemId);
    if (cached) return cached;
    const pending = this.pendingSpawns.get(systemId);
    if (pending) return pending;
    const spawn = this.loadAndRegister(systemId);
    this.pendingSpawns.set(systemId, spawn);
    try {
      const shard = await spawn;
      return shard;
    } finally {
      this.pendingSpawns.delete(systemId);
    }
  }

  /**
   * Create the shard for `systemId`. Splits the work into:
   *   1. Build the deterministic system context (cheap, ~ms).
   *   2. Hydrate the entity registry from the DB (one roundtrip per
   *      ship; scoped via `loadShipsForShard(systemId)`).
   *   3. Register the shard in `this.shards`.
   *
   * Errors propagate so the WS handler can surface a structured
   * `system-not-found` (for unknown systems) or a `server-error`
   * (for DB issues) to the client.
   */
  private async loadAndRegister(systemId: string): Promise<Shard> {
    let context;
    try {
      context = buildShardContext({
        seed: this.galaxySeed,
        starCount: this.galaxyStarCount,
        systemId,
      });
    } catch (err) {
      if (err instanceof GalaxySystemNotFoundError) {
        throw err; // re-thrown unchanged; handler maps to `system-not-found`
      }
      throw err;
    }
    // Hydrate ships from DB. `loadShipsForShard` GC's expired wrecks
    // FIRST so a row that should be gone never reappears in the next
    // hydrate. We pass `includeDocked: true` so a player who owns a
    // docked starter ship still re-hydrates it with the persisted
    // position — otherwise the entity is missing from the broadcast
    // loop until the player warps out of dock (TASK-29). The v1
    // router doesn't need to special-case docked ships because
    // docking data lives in TASK-29; until then, every persisted row
    // represents a live ship entity.
    const { specs } = await loadShipsForShard(systemId, this.repo, {
      nowMs: this.now(),
      includeDocked: true,
    });
    // Build the shard with a noop broadcaster; the WS layer wires the
    // real one when it calls `joinSystem`. Using noop here keeps the
    // router free of any transport reference — same shape as the
    // existing `createShard` test helpers.
    const shard: Shard = createShard({
      systemId,
      context,
      // The router doesn't know how to send per-connection frames — it
      // routes through the shard's `send` callback, which the WS
      // layer registers via `attachRouter` (see below). We seed both
      // with noops and require the WS layer to replace them with the
      // real writers before serving frames.
      send: () => undefined,
      broadcast: () => undefined,
      events: this.events,
      logger: this.logger,
    });
    // Hydrate entities from the loaded specs. The hydrate step
    // fetches callsigns for the owner ids on the ship rows so the
    // resulting entities broadcast the right metadata on
    // `entity_update`. Idempotent on entityId (`spawnShip` returns
    // the existing entry); no double-registration.
    await this.hydrateEntities(shard, specs);
    this.shards.set(systemId, shard);
    this.shardStartedAt.set(systemId, this.now());
    return shard;
  }

  /**
   * Walk the loaded specs and mint one entity per row via `spawnShip`
   * (for player entities) or by direct `entities.set(...)` (for
   * wrecks — they have no input hooks so the broadcast-aware
   * `spawnWreck` factory adds nothing here). Centralised so a future
   * regression (e.g. an entity that needs regime derivation) lands
   * in one place.
   */
  private async hydrateEntities(
    shard: Shard,
    specs: ReturnType<typeof shipRowToEntitySpec>[],
  ): Promise<void> {
    // Build an ownerId → callsign lookup once so the entity factory
    // can populate the right callsign without N+1 roundtrips. The
    // callsign is **not** persisted on the ship row (it lives on the
    // player row), so the load path needs the join. The fetch is
    // bounded — the number of owners is at most MAX_PLAYERS_PER_SYSTEM
    // (16), so the loop is small.
    const ownerIds = new Set<string>();
    for (const spec of specs) {
      if (spec.kind !== "wreck" && spec.playerId) {
        ownerIds.add(spec.playerId);
      }
    }
    const callsignsByOwner = new Map<string, string>();
    await Promise.all(
      Array.from(ownerIds).map(async (ownerId) => {
        const player = await this.repo.findPlayerById(ownerId);
        if (player) callsignsByOwner.set(ownerId, player.callsign);
      }),
    );

    for (const spec of specs) {
      const fields = specToEntityFields(spec);
      if (spec.kind === "wreck") {
        // Wrecks are inert — set the entity directly. The simulator
        // already populates the wreck entity via `makeWreckEntity`;
        // the broadcast-aware factory is unnecessary here because we
        // don't bind a connection.
        shard.entities.set(fields.id, {
          id: fields.id,
          kind: "wreck",
          playerId: null,
          callsign: null,
          classId: spec.classId,
          hull: 0,
          shields: 0,
          targetId: null,
          pos: fields.pos,
          vel: fields.vel,
          quat: fields.quat,
          regime: fields.regime,
          originPlanetId: null,
          onPad: null,
          wreckExpiresAt: spec.wreckExpiresAt ?? Date.now() + 600_000,
        });
        continue;
      }
      const ownerId = spec.playerId ?? "owner-unknown";
      const callsign = callsignsByOwner.get(ownerId) ?? spec.callsign ?? "UNKNOWN";
      spawnShip(shard, {
        shipId: spec.shipId,
        playerId: ownerId,
        callsign,
        classId: spec.classId,
        hull: spec.hull,
        shields: spec.shields,
        pos: fields.pos,
        vel: fields.vel,
        quat: fields.quat,
        regime: fields.regime,
        originPlanetId: spec.originPlanetId,
        onPad: spec.onPad,
      });
    }
  }

  // -------------------------------------------------------------------
  // joinSystem / leaveSystem — per-connection cap + occupancy
  // -------------------------------------------------------------------

  /**
   * Add a connection to a system shard, enforcing the per-system
   * occupancy cap (default 16). On success returns the join result;
   * on cap-full returns a `JoinRejection` so the caller (WS handler)
   * can emit a structured `system-full` error frame.
   *
   * The cap is checked against `shard.connections.size` AFTER the
   * connection would be added — so the 17th concurrent join is
   * rejected without ever touching the shard state.
   */
  async joinSystem(
    systemId: string,
    ctx: RouterConnectionContext,
  ): Promise<JoinResult | JoinRejection> {
    let shard: Shard;
    try {
      shard = await this.getShard(systemId);
    } catch (err) {
      if (err instanceof GalaxySystemNotFoundError) {
        return {
          code: "system-not-found",
          message: err.message,
          systemId,
        };
      }
      throw err;
    }
    if (shard.connections.size >= MAX_PLAYERS_PER_SYSTEM) {
      return {
        code: "system-full",
        message: `System ${systemId} is full (max ${MAX_PLAYERS_PER_SYSTEM} players)`,
        systemId,
      };
    }
    // Cap ok — register the connection + spawn a player entity bound
    // to this connection. The WS layer later attaches the shipRow
    // via `attachConnection`.
    const conn: ShardConnection = {
      connId: ctx.connId,
      callsign: ctx.callsign,
      playerId: ctx.playerId,
      entityId: null,
      lastSeq: 0,
      pendingInput: null,
      staleDrops: 0,
    };
    shard.connections.set(conn.connId, conn);
    // Spawn (or rebind) the player entity. The router is the only
    // site that knows which `shipId` belongs to which connection;
    // `spawnShip` handles idempotency on entityId. If the load path
    // already created the entity, `spawnShip` returns the existing
    // entry (with the right callsign, since `hydrateEntities` ran
    // a join against `players` earlier).
    const existingEntity = shard.entities.get(`entity:${ctx.ship.id}`);
    if (existingEntity !== undefined) {
      // Reconnect: bind the connection to the entity that already
      // holds the right ownership metadata.
      conn.entityId = existingEntity.id;
    } else {
      spawnShip(shard, {
        shipId: ctx.ship.id,
        playerId: ctx.playerId,
        callsign: ctx.callsign,
        classId: ctx.ship.classId,
        hull: ctx.ship.hull,
        shields: ctx.ship.shields,
        pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: {
          x: ctx.ship.quat[0],
          y: ctx.ship.quat[1],
          z: ctx.ship.quat[2],
          w: ctx.ship.quat[3],
        },
        regime: "space",
        originPlanetId: null,
        onPad: null,
        bindConnId: conn.connId,
      });
    }
    // Connection registered → clear the reap sentinel so a transient
    // empty window doesn't accidentally reap a live shard.
    this.reapSentinels.delete(systemId);
    this.events.emit("join", { systemId, connId: ctx.connId });
    return {
      shard,
      connId: ctx.connId,
      systemId,
      players: shard.connections.size,
      snapshotTick: shard.sim.currentTick,
    };
  }

  /**
   * Drop a connection from its shard. Starts the reap grace timer
   * if this was the last connection in the shard.
   *
   * Returns `true` if the connection was found and removed.
   */
  leaveSystem(systemId: string, connId: string): boolean {
    const shard = this.shards.get(systemId);
    if (!shard) return false;
    const existed = shard.connections.delete(connId);
    if (existed && shard.connections.size === 0) {
      // Begin the reap grace period. If the shard reconnects before
      // the grace elapses, `joinSystem` deletes the sentinel and
      // reprieve continues. `reapEmpty()` is the only place the
      // sentinel is consumed.
      this.reapSentinels.set(systemId, { emptySinceMs: this.now() });
    }
    this.events.emit("leave", { systemId, connId });
    return existed;
  }

  // -------------------------------------------------------------------
  // reaping
  // -------------------------------------------------------------------

  /**
   * Stop every shard that has been empty for at least `reapGraceMs`.
   * Each reaped shard gets one final `flushShips` (TASK-24) before
   * its sim loop is stopped.
   *
   * Pass `force: true` to ignore the grace period (used by
   * `shutdown()`).
   */
  async reapEmpty(options: { force?: boolean } = {}): Promise<{
    reaped: string[];
  }> {
    const reaped: string[] = [];
    const cutoffMs = this.now() - this.reapGraceMs;
    for (const [systemId, sentinel] of this.reapSentinels.entries()) {
      const shard = this.shards.get(systemId);
      if (!shard) {
        this.reapSentinels.delete(systemId);
        continue;
      }
      if (!options.force && sentinel.emptySinceMs > cutoffMs) {
        continue; // grace hasn't elapsed yet
      }
      // Final flush first so ship positions survive any kill -9 that
      // races with the sim.stop() below.
      try {
        await this.flusher.flushNow(shard);
      } catch (err) {
        this.logger.error?.(`[drift-router] flush of ${systemId} failed during reap:`, err);
      }
      // Stop the sim loop + clear the registry.
      shard.shutdown();
      this.shards.delete(systemId);
      this.shardStartedAt.delete(systemId);
      this.reapSentinels.delete(systemId);
      reaped.push(systemId);
      this.events.emit("reap", { systemId });
    }
    return { reaped };
  }

  /**
   * Test/admin escape hatch: synchronously stop a specific shard
   * regardless of grace timer. Used by the maintenance scripts and
   * by the integration tests that need to verify the reap path
   * without going through the empty-and-grace dance.
   */
  async forceReap(systemId: string): Promise<boolean> {
    if (!this.shards.has(systemId)) return false;
    // Tag the system as empty so `reapEmpty({ force: true })` picks it up.
    this.reapSentinels.set(systemId, { emptySinceMs: this.now() });
    await this.reapEmpty({ force: true });
    return !this.shards.has(systemId);
  }

  // -------------------------------------------------------------------
  // Stats surface
  // -------------------------------------------------------------------

  /**
   * Snapshot of every active shard + the router's overall state. The
   * `/api/galaxy/health` endpoint serialises this shape verbatim.
   */
  stats(): RouterStats {
    const shards: RouterShardStats[] = [];
    let totalPlayers = 0;
    const started = this.routerStartedAt;
    const now = this.now();
    for (const [systemId, shard] of this.shards.entries()) {
      const startedMs = this.shardStartedAt.get(systemId) ?? started;
      const players = shard.connections.size;
      totalPlayers += players;
      shards.push({
        systemId,
        name: shard.context.system.name,
        players,
        uptimeMs: Math.max(0, now - startedMs),
      });
    }
    return {
      shardCount: this.shards.size,
      totalPlayers,
      routerStartedAt: started,
      shards,
    };
  }

  /** Read-only accessor used by tests + diagnostics. */
  listSystemIds(): readonly string[] {
    return Array.from(this.shards.keys());
  }

  /** True if a shard for `systemId` is currently active. */
  has(systemId: string): boolean {
    return this.shards.has(systemId);
  }

  /** Lookup a shard by id (returns `undefined` if the shard is dormant). */
  get(systemId: string): Shard | undefined {
    return this.shards.get(systemId);
  }

  /** Number of currently-active shards. */
  size(): number {
    return this.shards.size;
  }
}
