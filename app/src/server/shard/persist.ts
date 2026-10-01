import { performance } from 'node:perf_hooks';

import { shipStats, isLivery } from '@shared/ships';
import type { Regime } from '@shared/physics/flight';
import type { Repository, ShipStateInput } from '@server/db/repo';
import type { ShipRegime, ShipRow } from '@server/db/schema';
import { WRECK_TTL_MS } from './shard';
import type { ShardLogger, SimEntity } from './types';

/**
 * Shard flush + restart load (TASK-24). Ships persist {pos, vel, quat,
 * regime, hull, shields, livery, onPad} so a shard restart — even kill -9 —
 * resumes where the sim left off instead of teleporting to spawn points.
 *
 * - `flushShips` writes every player-ship entity of one shard in ONE
 *   transaction (one upsert per ship; wrecks ride along as their owner row's
 *   state='destroyed' + destroyed_at, so there is no separate wreck table).
 * - `loadShips` reads every ship of the system, classifies it (fly at saved
 *   state / dock at dock coords / static wreck with remaining ttl) and
 *   deletes expired wreck rows in the same transaction (no orphan rows).
 *
 * The sim entities keep normalized 0..1 hull/shields; the DB stores absolute
 * points against the class caps (the boundary conversion is one place here).
 */

/** What a flush reads from the shard (SystemShard satisfies this). */
export interface ShardView {
  systemId: string;
  entities: ReadonlyMap<string, SimEntity>;
}

export interface FlushSummary {
  /** Ship rows upserted (one statement per ship). */
  saved: number;
  /** A destroyed entity was persisted (wreck record). */
  destroyed: number;
  ms: number;
}

/** A destroyed ship whose wreck is still within its ttl. */
export interface LoadedWreck {
  row: ShipRow;
  /** ms until the wreck expires (0 < remainingMs <= WRECK_TTL_MS). */
  remainingMs: number;
}

/** Everything a restarted shard needs to rebuild a system (step 2). */
export interface ShipsLoad {
  systemId: string;
  /** Non-destroyed ships: fly at saved state, or dock at dock coords. */
  ships: ShipRow[];
  /** Non-expired destroyed ships: rebuild as static wrecks. */
  wrecks: LoadedWreck[];
  /** Expired wreck rows deleted on load (no orphans). */
  deletedExpired: number;
}

export interface ShardPersistOptions {
  /** Injectable clock (tests use a fake now for wreck expiry). */
  now?: () => number;
  /** Repository factory inside transactions (tests spy on it). */
  repoForTransaction?: (repo: Repository) => Repository;
  /** Called when a flush fails (errors must not kill the shard). */
  log?: ShardLogger;
}

export interface ShardPersist {
  /** Save point: flush every player-ship entity of the shard (one tx). */
  flushShips(shard: ShardView): Promise<FlushSummary>;
  /** Load point: ships + unexpired wrecks of the system, expired deleted. */
  loadShips(): Promise<ShipsLoad>;
}

export function createShardPersist(deps: {
  repo: Repository;
  systemId: string;
  options?: ShardPersistOptions;
}): ShardPersist {
  const { repo, systemId } = deps;
  const now = deps.options?.now ?? (() => Date.now());
  const log = deps.options?.log;
  const txFactory = deps.options?.repoForTransaction ?? ((r) => r);

  const inThisSystem = (row: ShipRow): boolean => row.position.systemId === systemId;

  /** Convert one sim entity to the persisted state (normalized → points). */
  function entityToInput(e: SimEntity): ShipStateInput {
    const cls = shipStats(e.classId);
    const state: ShipStateInput['state'] = e.destroyed
      ? 'destroyed'
      : e.docked || e.ship.onPad
        ? 'docked'
        : 'flying';
    const input: ShipStateInput = {
      hull: e.hull * cls.hull,
      shields: e.shields * cls.shieldCapacity,
      position: {
        systemId,
        x: e.ship.pos.x,
        y: e.ship.pos.y,
        z: e.ship.pos.z,
      },
      velocity: { ...e.ship.vel },
      rotation: { ...e.ship.quat },
      regime: e.ship.regime as ShipRegime,
      onPad: e.ship.onPad ?? null,
      state,
      destroyedAt: e.destroyed ? new Date(e.destroyedAtMs ?? now()).toISOString() : null,
    };
    // Livery only when it is the exact 3-slot contract (the route is the
    // authoritative livery writer; a partial value must not clobber it).
    if (isLivery(e.livery)) input.livery = e.livery;
    return input;
  }

  return {
    async flushShips(shard) {
      // Nothing to do: skip the transaction entirely.
      const shipCount = [...shard.entities.values()].filter(
        (e) => e.kind === 'ship' && e.playerId,
      ).length;
      if (shipCount === 0) return { saved: 0, destroyed: 0, ms: 0 };

      const t0 = performance.now();
      const { saved, destroyed } = await repo.withTransaction(async (r) => {
        const txRepo = txFactory(r);
        // ONE multi-row upsert statement for the WHOLE shard (the
        // uq_ships_owner key is the conflict target) in one small
        // transaction — a flush never blocks a 50 ms tick (step 4: p95
        // < 8 ms). Wrecks ride along as their owner's destroyed row.
        let destroyedN = 0;
        const rows: Array<{ ownerId: string; classId: string; state: ShipStateInput }> = [];
        for (const e of shard.entities.values()) {
          // AI ships have no row (they are seeded, TASK-45/46).
          if (e.kind !== 'ship' || !e.playerId) continue;
          if (e.destroyed) destroyedN += 1;
          rows.push({ ownerId: e.playerId, classId: e.classId, state: entityToInput(e) });
        }
        const savedN = await txRepo.upsertShipStates(rows);
        return { saved: savedN, destroyed: destroyedN };
      });
      const ms = performance.now() - t0;
      log?.debug('shard flush', { systemId: shard.systemId, saved, destroyed, ms });
      return { saved, destroyed, ms };
    },

    async loadShips() {
      const nowMs = now();
      return repo.withTransaction(async (r) => {
        const txRepo = txFactory(r);
        const rows = (await txRepo.listShipsInSystem(systemId)).filter(inThisSystem);
        const ships: ShipRow[] = [];
        const wrecks: LoadedWreck[] = [];
        const expired: string[] = [];
        for (const row of rows) {
          if (row.state !== 'destroyed') {
            ships.push(row);
            continue;
          }
          const destroyedAt = row.destroyedAt ? Date.parse(row.destroyedAt) : NaN;
          if (!Number.isFinite(destroyedAt) || destroyedAt + WRECK_TTL_MS <= nowMs) {
            expired.push(row.id); // ttl over (or corrupt): drop the row
          } else {
            wrecks.push({ row, remainingMs: destroyedAt + WRECK_TTL_MS - nowMs });
          }
        }
        const deletedExpired = await txRepo.deleteShips(expired);
        return { systemId, ships, wrecks, deletedExpired };
      });
    },
  };
}

/**
 * The 30 s flush cadence (PRD §8: state continuity, not frame-exact). The
 * timer is unref'd so it never holds the process open; a failed flush logs
 * and retries on the next tick instead of killing the shard.
 */
export function startShardFlushTimer(opts: {
  flush: () => Promise<unknown>;
  intervalMs: number;
  log?: ShardLogger;
}): () => void {
  const timer = setInterval(() => {
    void opts.flush().catch((err: unknown) => {
      opts.log?.warn('shard flush failed', { error: String(err) });
    });
  }, opts.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Regime guard for rows read back from a foreign/corrupt DB. */
export function validRegime(value: unknown): value is Regime {
  return value === 'space' || value === 'atmosphere' || value === 'surface';
}
