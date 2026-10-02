import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import type { SystemGen } from '@shared/galaxy/types';
import { spawnGatePose } from '@shared/galaxy/spawn';
import { shipStats } from '@shared/ships';
import { MAX_PLAYERS_PER_SYSTEM } from '@shared/protocol';
import type { StateSnapshot } from '@shared/protocol/schemas';
import type { Repository } from '@server/db/repo';
import type { ShipSwapBus } from '@server/shards';
import {
  SystemShard,
  createShardPersist,
  type FlushSummary,
  type ShardPersist,
  type ShardLogger,
} from '@server/shard';

/**
 * The galaxy router (TASK-11): the single application instance hosts any
 * number of system shards in-process. A shard is spawned when a player joins
 * its system (system data regenerated deterministically from GALAXY_SEED,
 * ships rehydrated via the TASK-24 persist service) and reaped 60 s after its
 * last connection leaves (ships flushed to the DB before the sim stops).
 *
 * This is the v1 single-instance design; the GalaxyRouter interface is the
 * seam a future process-level shard manager would replace.
 */

/** Reap cadence: how often the router scans for empty shards (5 s). */
export const REAP_INTERVAL_MS = 5_000;
/** An empty shard survives this long after its last leave before reaping. */
export const REAP_GRACE_MS = 60_000;
/** Shard load budget: a typical system must load faster than this (500 ms). */
export const SHARD_LOAD_BUDGET_MS = 500;

/** Everything that is alive for one active shard. */
export interface ActiveShard {
  shard: SystemShard;
  /** The deterministically generated system (planets, docks, AI roster). */
  system: SystemGen;
  name: string;
  /** epoch ms the shard was created (uptimeMs anchor). */
  createdAt: number;
  /** ms the load took (system generation + ship rehydration + first start). */
  loadMs: number;
  /** The TASK-24 flush/load service for this system's ships. */
  persist: ShardPersist;
  /**
   * Shard generation (TASK-12): incremented once per (re)load from the DB.
   * The router never reloads while connections exist (only a fresh spawn
   * after reap/shutdown loads), so a stable generation across a
   * leave/rejoin proves the shard was REUSED, not reloaded mid-flight.
   */
  generation: number;
  /**
   * epoch ms since the shard last sat at zero connections (undefined while
   * occupied or before the first empty scan stamped it).
   */
  graceSince: number | undefined;
}

export interface RouterPlayer {
  playerId: string;
  callsign: string;
  /**
   * Deliver serialized protocol frames to this player's socket (the WS
   * layer supplies it; direct callers may omit it → frames are dropped).
   */
  send?: (buffer: string) => void;
  /**
   * TASK-17: opaque identity of the WS connection (the WS layer passes its
   * Conn). Lets the shard reject stale inputs / leaves from a superseded
   * (zombie) socket of the same player after a reconnect.
   */
  source?: unknown;
}

export type RouterEnterResult =
  | { ok: true; snapshot: StateSnapshot }
  | { ok: false; code: 'system-full' | 'system-not-found'; message: string };

export interface GalaxyRouter {
  /**
   * Return the active shard for a system, spawning it on first use.
   * Idempotent: concurrent calls for the same system share ONE load
   * (pending-promise collapse). Unknown system ids resolve to undefined.
   */
  getShard(systemId: string): Promise<ActiveShard | undefined>;
  /** Synchronous lookup (no spawn). */
  active(systemId: string): ActiveShard | undefined;
  /**
   * Join: getShard + cap check + connection reservation. The cap check and
   * the slot reservation happen back-to-back with no await between them, so
   * the 17th concurrent join is rejected even when it races the 16th.
   */
  enter(systemId: string, player: RouterPlayer): Promise<RouterEnterResult>;
  /**
   * Leave: release the connection; starts the reap grace when empty. When
   * `source` is given, a leave from a superseded (zombie) connection of the
   * same player is ignored (TASK-17).
   */
  leave(systemId: string, playerId: string, source?: unknown): void;
  /**
   * TASK-8 inter-system warp: move the player's ship from `fromSystemId`
   * to `targetSystemId`. Validates the target (seed lookup) and the cap;
   * on success the ship is removed ENTIRELY from the source shard (no idle
   * ghost), repositioned at the target's spawn gate (100 u +X of the star,
   * facing it), the ship row's systemId moves with it (TASK-24 flush/load
   * stays consistent), and the enter-snapshot of the target is returned.
   * On failure (system-full / not-found / no ship) the player is left
   * exactly where they were.
   */
  warp(
    fromSystemId: string,
    targetSystemId: string,
    player: RouterPlayer,
  ): Promise<RouterEnterResult>;
  /**
   * Reap pass: stamps the grace on empty shards and stops (ships flushed
   * first) those whose grace elapsed. Returns the number of shards reaped.
   */
  reapEmpty(): Promise<number>;
  /** Start the unref'd reap interval; returns a stop function. */
  startReaper(intervalMs?: number): () => void;
  /**
   * Start the unref'd periodic flush of every ACTIVE shard (the crash
   * bound: a SIGKILL loses at most one period). Returns a stop function.
   */
  startPeriodicFlush(intervalMs: number): () => void;
  /** Router stats for GET /api/galaxy/health (auth). */
  stats(): Array<{ systemId: string; name: string; players: number; uptimeMs: number }>;
  /** Stop + flush every active shard (graceful shutdown). */
  stopAll(): Promise<void>;
}

export interface GalaxyRouterDeps {
  repo: Repository;
  galaxySeed: string;
  shipSwapBus: ShipSwapBus;
  /** Injectable clock (tests use a fake now for the reap grace). */
  now?: () => number;
  /** Reap grace override (tests). */
  graceMs?: number;
  log?: ShardLogger;
}

export function createGalaxyRouter(deps: GalaxyRouterDeps): GalaxyRouter {
  const { repo, galaxySeed, shipSwapBus } = deps;
  const now = deps.now ?? (() => Date.now());
  const graceMs = deps.graceMs ?? REAP_GRACE_MS;
  const log = deps.log;

  // Every valid system id derives from a star of the seed: systemId =
  // hash(seed, starId), NOT the star id itself. Precomputing all systems is
  // cheap (200 systems ≈ 20 ms) and makes getShard's validity check O(1);
  // the generated system is the shard's in-memory cache of world data
  // (PRD §6: geometry is derived from the seed, never stored).
  const systems = new Map<string, SystemGen>();
  for (const star of generateStars(galaxySeed)) {
    const system = generateSystem(galaxySeed, star.id);
    systems.set(system.systemId, system);
  }
  const shards = new Map<string, ActiveShard>();
  /** In-flight loads: collapse concurrent spawns of the same system. */
  const pending = new Map<string, Promise<ActiveShard | undefined>>();
  /**
   * Loads run ONE AT A TIME: the ship rehydration is a small DB transaction
   * on a shared connection, and interleaved transactions would abort each
   * other (a concurrent spawn must never wedge a shard load).
   */
  let loadChain: Promise<void> = Promise.resolve();
  /**
   * Ship flushes (periodic / reap / shutdown) run ONE AT A TIME: they are
   * small transactions on a shared connection, and interleaved ones would
   * abort each other mid-write.
   */
  let flushChain: Promise<void> = Promise.resolve();
  /**
   * Per-system generation counters (TASK-12): bumped on every (re)load from
   * the DB. Kept after reaps on purpose — the generation identifies "the
   * Nth lifetime of this system's shard in this process".
   */
  const generations = new Map<string, number>();

  function queueFlush(loaded: ActiveShard): Promise<FlushSummary> {
    const p = flushChain.then(() => loaded.persist.flushShips(loaded.shard));
    flushChain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async function getShard(systemId: string): Promise<ActiveShard | undefined> {
    const existing = shards.get(systemId);
    if (existing) return existing;
    const inflight = pending.get(systemId);
    if (inflight) return inflight;
    const generated = systems.get(systemId);
    if (!generated) return undefined;
    const name = generated.name;

    const loadFn = async (): Promise<ActiveShard> => {
      const t0 = performance.now();
      // System data is the precomputed, seed-derived generation (cheap and
      // idempotent); only ships/players persist (PRD §6).
      const system = generated;
      const persist = createShardPersist({ repo, systemId, options: { now, log } });
      const shard = new SystemShard({
        systemId,
        galaxySeed,
        system,
        repo,
        shipSwapBus,
        // The stop() snapshot hook stays synchronous no-op; the authoritative
        // write is the explicit async flush (reap / shutdown).
        persist: () => {},
        log,
      });
      // Load persisted state BEFORE ticking (no spawn teleports, TASK-24).
      const loaded = await persist.loadShips();
      await shard.loadShips(loaded);
      shard.start();
      await repo.upsertSystem(systemId, name, true);
      // A (re)load from the DB is a fresh shard generation (TASK-12).
      const generation = (generations.get(systemId) ?? 0) + 1;
      generations.set(systemId, generation);
      const active: ActiveShard = {
        shard,
        system,
        name,
        createdAt: now(),
        loadMs: performance.now() - t0,
        persist,
        graceSince: undefined,
        generation,
      };
      shards.set(systemId, active);
      if (active.loadMs > SHARD_LOAD_BUDGET_MS) {
        log?.warn('shard load over budget', { systemId, loadMs: active.loadMs });
      } else {
        log?.debug('shard loaded', { systemId, loadMs: active.loadMs, ships: loaded.ships.length });
      }
      return active;
    };
    // Queue behind any in-flight load; the chain itself never rejects.
    const load = loadChain.then(loadFn);
    loadChain = load.then(
      () => undefined,
      () => undefined,
    );
    pending.set(
      systemId,
      load.finally(() => pending.delete(systemId)),
    );
    return load;
  }

  function active(systemId: string): ActiveShard | undefined {
    return shards.get(systemId);
  }

  async function enter(systemId: string, player: RouterPlayer): Promise<RouterEnterResult> {
    const loaded = await getShard(systemId);
    if (!loaded) {
      return {
        ok: false,
        code: 'system-not-found',
        message: `system ${systemId} not found`,
      };
    }
    const shard = loaded.shard;
    // From here the cap check and slot reservation are synchronous (no
    // await between them), so the cap can never be overshot by a race.
    if (shard.connections.size >= MAX_PLAYERS_PER_SYSTEM) {
      return {
        ok: false,
        code: 'system-full',
        message: `system ${systemId} is full (${MAX_PLAYERS_PER_SYSTEM} players)`,
      };
    }
    shard.registerConnection(
      player.playerId,
      player.callsign,
      player.send ?? (() => {}),
      player.source,
    );
    const entity = await shard.adoptEntity(player.playerId, player.callsign);
    if (!entity) {
      // No ship row (should be impossible: claim always grants a starter
      // ship). Release the reserved slot rather than leak it.
      shard.leavePlayer(player.playerId);
      return {
        ok: false,
        code: 'system-not-found',
        message: `no ship for player ${player.playerId}`,
      };
    }
    loaded.graceSince = undefined; // occupied again: any pending grace is void
    return { ok: true, snapshot: enterSnapshot(loaded, player.playerId) };
  }

  function leave(systemId: string, playerId: string, source?: unknown): void {
    const loaded = shards.get(systemId);
    if (!loaded) return;
    loaded.shard.leavePlayer(playerId, source);
    if (loaded.shard.connections.size === 0) {
      // Stamp the grace exactly when the LAST player leaves.
      loaded.graceSince = loaded.graceSince ?? now();
    } else {
      loaded.graceSince = undefined;
    }
  }

  /**
   * TASK-8 warp A → B. Order matters:
   * 1. the target is validated (seed lookup) and its cap checked BEFORE
   *    anything in the source changes — a rejected warp never moves the
   *    player;
   * 2. the target slot is reserved back-to-back with the cap check (no
   *    await between them, same atomicity as enter());
   * 3. the ship row is written to the target first (position.systemId =
   *    target + gate pose), so the TASK-24 flush/load boundary already sees
   *    the ship as "in B" even mid-teleport;
   * 4. only then is the ship removed from the source shard (connection AND
   *    entity — no idle ghost) and the source reap grace stamped.
   */
  async function warp(
    fromSystemId: string,
    targetSystemId: string,
    player: RouterPlayer,
  ): Promise<RouterEnterResult> {
    if (fromSystemId === targetSystemId) {
      return {
        ok: false,
        code: 'system-not-found',
        message: `already in system ${targetSystemId}`,
      };
    }
    const target = await getShard(targetSystemId);
    if (!target) {
      return {
        ok: false,
        code: 'system-not-found',
        message: `system ${targetSystemId} not found`,
      };
    }
    // Cap check + slot reservation with no await between them: a 17th
    // concurrent warp-in is rejected, never overshot.
    if (target.shard.connections.size >= MAX_PLAYERS_PER_SYSTEM) {
      return {
        ok: false,
        code: 'system-full',
        message: `system ${targetSystemId} is full (${MAX_PLAYERS_PER_SYSTEM} players)`,
      };
    }
    target.shard.registerConnection(
      player.playerId,
      player.callsign,
      player.send ?? (() => {}),
      player.source,
    );
    const row = await repo.getShipByOwner(player.playerId);
    if (!row) {
      // No ship row (should be impossible: claim grants a starter ship).
      // Release the reserved slot; the player stays in the source system.
      target.shard.leavePlayer(player.playerId);
      return {
        ok: false,
        code: 'system-not-found',
        message: `no ship for player ${player.playerId}`,
      };
    }
    // TASK-39: the cargo hold travels with the ship. The SOURCE shard's
    // in-memory hold is the authority (the row may be a flush period stale)
    // — it is written into the row below so the target's adopt rehydrates it.
    const cargo = shards.get(fromSystemId)?.shard.getCargo(player.playerId);
    const gate = spawnGatePose();
    // Warp is a teleport by design: adopt (or re-adopt a rehydrated) entity
    // at the target, then reposition it at the gate.
    const entity = await target.shard.adoptEntity(player.playerId, player.callsign);
    if (entity) {
      entity.ship.pos = { ...gate.pos };
      entity.ship.vel = { x: 0, y: 0, z: 0 };
      entity.ship.quat = { ...gate.quat };
      entity.ship.regime = 'space';
      entity.ship.onPad = undefined;
      entity.docked = false;
      entity.idle = false;
      entity.heldInput = undefined;
    }
    // The row follows the ship: target system, gate pose, flying.
    const cls = shipStats(row.classId);
    await repo.saveShipState(row.id, {
      hull: entity ? entity.hull * cls.hull : row.hull,
      shields: entity ? entity.shields * cls.shieldCapacity : row.shields,
      position: { systemId: targetSystemId, ...gate.pos },
      velocity: { x: 0, y: 0, z: 0 },
      state: 'flying',
      rotation: gate.quat,
      regime: 'space',
      onPad: null,
      ...(cargo ? { cargo: JSON.stringify(cargo.stacks) } : {}),
    });
    // Only now does the source let go: connection AND entity leave the shard
    // (no idle ghost), then the grace stamp runs via leave() (leavePlayer is
    // a no-op at that point — the connection is already gone).
    const source = shards.get(fromSystemId);
    if (source) source.shard.removePlayer(player.playerId);
    leave(fromSystemId, player.playerId);
    target.graceSince = undefined; // occupied again: any pending grace is void
    log?.info('warp complete', {
      from: fromSystemId,
      to: targetSystemId,
      player: player.playerId,
    });
    return { ok: true, snapshot: enterSnapshot(target, player.playerId) };
  }

  async function reapEmpty(): Promise<number> {
    const nowMs = now();
    let reaped = 0;
    for (const [systemId, loaded] of [...shards]) {
      if (loaded.shard.connections.size > 0) {
        loaded.graceSince = undefined;
        continue;
      }
      if (loaded.graceSince === undefined) {
        loaded.graceSince = nowMs;
        continue;
      }
      if (nowMs - loaded.graceSince < graceMs) continue;
      // Grace elapsed: flush the ships FIRST (one small transaction), then
      // stop the sim, then drop the shard from the map.
      try {
        const summary = await queueFlush(loaded);
        log?.info('shard reap flush', { systemId, ...summary });
      } catch (err) {
        // A failed flush must not wedge the reaper: the shard stays
        // active (still empty) and is retried on the next pass.
        log?.warn('shard reap flush failed; keeping shard', { systemId, error: String(err) });
        continue;
      }
      loaded.shard.stop();
      await repo.upsertSystem(systemId, loaded.name, false);
      shards.delete(systemId);
      reaped += 1;
      log?.info('shard reaped', { systemId, uptimeMs: nowMs - loaded.createdAt });
    }
    return reaped;
  }

  function startReaper(intervalMs: number = REAP_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      void reapEmpty().catch((err: unknown) =>
        log?.warn('reap pass failed', { error: String(err) }),
      );
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  function startPeriodicFlush(intervalMs: number): () => void {
    const timer = setInterval(() => {
      // One enqueued flush per active shard (the chain serializes them).
      for (const loaded of [...shards.values()]) {
        void queueFlush(loaded).catch((err: unknown) =>
          log?.warn('periodic shard flush failed', {
            systemId: loaded.shard.systemId,
            error: String(err),
          }),
        );
      }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  function stats(): Array<{ systemId: string; name: string; players: number; uptimeMs: number }> {
    const nowMs = now();
    return [...shards.values()].map((loaded) => ({
      systemId: loaded.shard.systemId,
      name: loaded.name,
      players: loaded.shard.connections.size,
      uptimeMs: nowMs - loaded.createdAt,
    }));
  }

  async function stopAll(): Promise<void> {
    for (const [systemId, loaded] of [...shards]) {
      await queueFlush(loaded).catch((err: unknown) => {
        log?.warn('shutdown flush failed', { systemId, error: String(err) });
      });
      loaded.shard.stop();
      await repo.upsertSystem(systemId, loaded.name, false);
      shards.delete(systemId);
    }
  }

  return {
    getShard,
    active,
    enter,
    leave,
    warp,
    reapEmpty,
    startReaper,
    startPeriodicFlush,
    stats,
    stopAll,
  };
}

/**
 * The initial full snapshot a joining player receives: every entity in the
 * shard (their own ship already included — adopt ran before this), plus the
 * callsigns of the players already in-system (the WS layer separately
 * broadcasts the presence 'join' event to those peers).
 */
function enterSnapshot(loaded: ActiveShard, selfPlayerId: string): StateSnapshot {
  return {
    systemId: loaded.shard.systemId,
    entities: loaded.shard.snapshot(),
    nodes: [], // node states stream in TASK-26
    chat: loaded.shard.chatHistory(), // TASK-16: last 100 system messages
    players: [...loaded.shard.connections.values()]
      .filter((c) => c.playerId !== selfPlayerId)
      .map((c) => ({ playerId: c.playerId, callsign: c.callsign })),
  };
}
