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
import type { Shard } from "../shard/types.js";
import { ShardFlushService } from "../shard/persist.js";

import { GalaxySystemNotFoundError } from "./system-data.js";
import { firePresenceBroadcast, type PresenceBroadcaster } from "./presence.js";
import { bindConnectionToEntity, makeShardConnection } from "./router-connection.js";
import { routerShutdown, routerStart } from "./router-lifecycle.js";
import { loadAndRegister, type RouterShardMaps } from "./router-load.js";
import { reapEmpty } from "./router-reap.js";
import { buildRouterStats, readGeneration } from "./router-stats.js";
import type {
  JoinRejection,
  JoinResult,
  RouterConnectionContext,
  RouterOptions,
  RouterStats,
} from "./router-types.js";

// Re-export the public types from `./router-types` so callers can
// keep using the same `import { ... } from "./router.js"` surface.
export type {
  JoinRejection,
  JoinResult,
  RouterConnectionContext,
  RouterOptions,
  RouterShardStats,
  RouterStats,
} from "./router-types.js";

/**
 * Re-export so existing imports (`import { PresenceBroadcaster } from
 * "./router.js"`) continue to work — the type lives in `./presence.ts`
 * for module cohesion but the router is the public face of the
 * galaxy layer.
 */
export type { PresenceBroadcaster } from "./presence.js";

// ---------------------------------------------------------------------------
// Public types live in `./router-types.ts` (re-exported above).
// ---------------------------------------------------------------------------

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
  /**
   * TASK-12: per-system generation counter. Bumped every time the
   * router (re)spawns a shard for `systemId`. The reconnect-storm
   * test reads this from the shard (via `shard.generation`) to
   * confirm a join+leave burst did not trigger a DB reload.
   */
  private readonly shardGeneration = new Map<string, number>();
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
  /**
   * TASK-12: optional presence broadcaster. When set, the router
   * fires `presence` frames on join/leave/reap so the WS layer can
   * echo the change to every connection in the system. Default =
   * silent (the test-only no-op path).
   */
  private readonly presenceBroadcaster: PresenceBroadcaster | undefined;

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
    this.presenceBroadcaster = options.presenceBroadcaster;

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
    routerStart(this.lifecycleDeps());
  }

  /**
   * Stop the reap timer + reap every shard + flush + clear. Idempotent.
   *
   * Used by the server graceful-shutdown hook (`SIGTERM/SIGINT`).
   * Each shard is flushed first so a hard `kill -9` after
   * `shutdown()` cannot leave ships missing from the DB.
   */
  async shutdown(): Promise<void> {
    await routerShutdown(this.lifecycleDeps());
  }

  /** Snapshot the router's mutable state for the lifecycle helpers. */
  private lifecycleDeps() {
    return {
      reapIntervalMs: this.reapIntervalMs,
      runSweep: () => this.reapEmpty(),
      clearTimer: () => {
        if (this.reapTimer !== null) {
          clearInterval(this.reapTimer);
          this.reapTimer = null;
        }
      },
      reapAllForce: () => this.reapEmpty({ force: true }),
      disposeFlusher: () => this.flusher.dispose(),
      getTimer: () => this.reapTimer,
      setTimer: (timer: ReturnType<typeof setInterval> | null) => {
        this.reapTimer = timer;
      },
      getDisposed: () => this.disposed,
      setDisposed: (disposed: boolean) => {
        this.disposed = disposed;
      },
    };
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
   *
   * Delegated to `./router-load.ts` so this module stays under the
   * AGENTS.md file-size cap.
   */
  private async loadAndRegister(systemId: string): Promise<Shard> {
    return loadAndRegister(systemId, {
      repo: this.repo,
      galaxySeed: this.galaxySeed,
      galaxyStarCount: this.galaxyStarCount,
      events: this.events,
      logger: this.logger,
      now: this.now,
      maps: this.shardMaps(),
    });
  }

  /** Snapshot the router's mutable shard maps for the load helper. */
  private shardMaps(): RouterShardMaps {
    return {
      shards: this.shards,
      shardStartedAt: this.shardStartedAt,
      shardGeneration: this.shardGeneration,
    };
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
    // via `attachConnection`. Delegated to `./router-connection.ts`
    // so this module stays under the AGENTS.md file-size cap.
    const conn = makeShardConnection(ctx);
    shard.connections.set(conn.connId, conn);
    bindConnectionToEntity(shard, conn, ctx);
    // Connection registered → clear the reap sentinel so a transient
    // empty window doesn't accidentally reap a live shard.
    this.reapSentinels.delete(systemId);
    this.events.emit("join", { systemId, connId: ctx.connId });
    // TASK-12: broadcast the join to existing connections so every
    // other client in the system learns about the new player. The
    // WS layer (via the presence broadcaster hook) decides whether
    // to echo the frame back to the originator; the router just
    // ships the canonical roster.
    this.broadcastPresence(shard);
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
    if (existed) {
      // TASK-12: broadcast the leave to remaining connections. We
      // only ship the frame when the connection was actually
      // registered so a stray `leaveSystem` for an unknown connId
      // doesn't churn the broadcast. We broadcast AFTER the delete
      // so the leaving connection isn't included in the roster
      // (their client shouldn't see themselves in the new frame).
      // `buildPresencePayload` returns `null` when the shard is now
      // empty (no remaining listeners) so the broadcaster is a
      // no-op; the reap path emits a separate empty-roster frame.
      this.broadcastPresence(shard);
    }
    this.events.emit("leave", { systemId, connId });
    return existed;
  }

  /**
   * TASK-12: build the canonical presence payload for the shard and
   * invoke the presence broadcaster hook. The payload includes one
   * `PresenceEntry` per active connection in the shard.
   *
   * Delegated to `firePresenceBroadcast` / `buildPresencePayload` in
   * `./presence.ts` so the router doesn't accumulate wire-shape
   * code. For v1 every connection reports `state: 'flying'`; the
   * docked/on-foot refinement (TASK-29 / TASK-31) replaces the
   * hard-coded value with the player's actual `ActivityState`.
   */
  private broadcastPresence(shard: Shard): void {
    firePresenceBroadcast(this.presenceBroadcaster, shard);
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
   *
   * Delegated to `./router-reap.ts` to keep this module under the
   * AGENTS.md file-size cap.
   */
  async reapEmpty(options: { force?: boolean } = {}): Promise<{
    reaped: string[];
  }> {
    return reapEmpty({
      reapSentinels: this.reapSentinels,
      shards: this.shards,
      shardStartedAt: this.shardStartedAt,
      flusher: this.flusher,
      presenceBroadcaster: this.presenceBroadcaster,
      events: this.events,
      logger: this.logger,
      reapGraceMs: this.reapGraceMs,
      now: this.now,
      force: options.force,
    });
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
   * Delegated to `./router-stats.ts` to keep this module under the
   * AGENTS.md file-size cap.
   */
  stats(): RouterStats {
    return buildRouterStats({
      shards: this.shards,
      shardStartedAt: this.shardStartedAt,
      routerStartedAt: this.routerStartedAt,
      now: this.now,
    });
  }

  /** Read-only accessor used by tests + diagnostics. */
  listSystemIds(): readonly string[] {
    return Array.from(this.shards.keys());
  }

  /**
   * TASK-12: read the current generation counter for `systemId`.
   * Returns 0 when the shard has never been spawned in this router
   * instance — useful for tests that want to assert "the counter
   * never moved from the value I last saw".
   */
  generationFor(systemId: string): number {
    return readGeneration({ shardGeneration: this.shardGeneration, systemId });
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
