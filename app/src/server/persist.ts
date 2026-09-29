import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { DbHandle } from './db/client';
import { getDb } from './db/client';
import type { Repository } from './db/repo';
import { createRepo } from './db/repo';
import {
  type CargoRow,
  pgTables,
  type NodeStateRow,
  type Schema,
  type ShipRow,
  sqliteTables,
} from './db/schema';

// Drift persists mutable state at a few defined save points (PRD §8) so a
// shard restart — even kill -9 — loses nothing material: on dock, when hull
// crosses a 75/50/25% damage milestone, every 5 s for dirty ships, and on
// shard shutdown. Writes always go through the repository layer, and each
// save point is one transaction (a single-row save is one atomic statement).

/** Hull percentages at which damage is force-persisted. */
export const HULL_MILESTONES = [75, 50, 25] as const;
export const DEFAULT_SAVE_INTERVAL_MS = 5000;

export interface CargoItemInput {
  resourceType: string;
  quantity: number;
}

export interface NodeStateInput {
  nodeId: string;
  quantityRemaining: number;
  respawnAt?: string | null;
}

/** Everything a shard needs to resume a system after a crash. */
export interface SystemState {
  systemId: string;
  ships: ShipRow[];
  cargo: CargoRow[];
  /** Player id → credits. */
  credits: Record<string, number>;
  nodeStates: NodeStateRow[];
}

export interface SaveSummary {
  saved: number;
  ms: number;
}

export interface PersistOptions {
  /** Interval-save period in ms (default 5000). */
  intervalMs?: number;
  /** Start the interval timer in the constructor (default false). */
  autoStart?: boolean;
  /** unref() the timer so it cannot hold the process open (default true). */
  unrefTimer?: boolean;
  /**
   * Repository factory used inside transactions (default createRepo).
   * The argument is the drizzle tx (postgres) or the shared db (sqlite,
   * which is single-connection so the manual BEGIN/COMMIT scopes it).
   * Tests inject a spy-wrapped factory to observe batched writes.
   */
  repoForTransaction?: (tx: unknown) => Repository;
  /** Called when the interval save fails (errors must not kill the shard). */
  onError?: (err: unknown) => void;
}

export interface PersistDeps {
  /** Full db handle ({ db, driver, raw }) so the right tx path is chosen. */
  handle: DbHandle;
  repo: Repository;
  options?: PersistOptions;
}

export interface PersistService {
  /** Remember the latest snapshot of a ship and mark it dirty. */
  markDirty(ship: ShipRow): void;
  isDirty(shipId: string): boolean;
  dirtyShipIds(): string[];
  /** Persist one ship's state now (position/velocity/hull/shields/state). */
  saveShip(ship: ShipRow): Promise<ShipRow>;
  /** Upsert several cargo lines for one ship in a single transaction. */
  saveCargo(shipId: string, items: CargoItemInput[]): Promise<CargoRow[]>;
  /** Upsert several resource-node states for one system in one transaction. */
  saveNodeStates(systemId: string, states: NodeStateInput[]): Promise<void>;
  /** Load the persisted state of a system (ships, cargo, credits, nodes). */
  loadSystemState(systemId: string, nodeIds?: string[]): Promise<SystemState>;
  /** Save point: dock. Persist the ship and clear its dirty flag. */
  onDock(ship: ShipRow): Promise<ShipRow>;
  /** Save point: damage. Persist only when hull crossed a milestone down. */
  onDamage(ship: ShipRow): Promise<boolean>;
  /** Save point: interval. Batch all dirty ships into one transaction. */
  saveDirty(): Promise<SaveSummary>;
  /** Save point: shard shutdown. Flush dirty ships + node states, one tx. */
  onShardShutdown(systemId: string, nodeStates?: NodeStateInput[]): Promise<SaveSummary>;
  /** Hull of the ship at its last persisted save (undefined if never saved). */
  lastSavedHull(shipId: string): number | undefined;
  start(): void;
  stop(): void;
}

export function createPersistService(deps: PersistDeps): PersistService {
  const { handle, repo } = deps;
  const options = deps.options ?? {};
  const intervalMs = options.intervalMs ?? DEFAULT_SAVE_INTERVAL_MS;
  const tables: Schema = handle.driver === 'sqlite' ? sqliteTables : pgTables;
  const dirty = new Set<string>();
  const shipCache = new Map<string, ShipRow>();
  const lastHull = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;

  const factory =
    options.repoForTransaction ?? ((tx: unknown) => createRepo(tx as DbHandle['db'], tables));

  /**
   * Run `fn` inside one database transaction.
   * Postgres: drizzle's async transaction.
   * SQLite: better-sqlite3 transactions only accept *synchronous* callbacks,
   * so the boundary is manual BEGIN/COMMIT on the single shared connection —
   * safe because the repo queries execute on this same thread/connection and
   * nothing else can interleave between the awaits.
   */
  async function withTransaction<T>(fn: (txRepo: Repository) => Promise<T>): Promise<T> {
    if (handle.driver === 'sqlite') {
      const raw = handle.raw as BetterSqlite3Database;
      raw.exec('BEGIN');
      try {
        const result = await fn(factory(handle.db));
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    }
    const pgDb = handle.db as unknown as {
      transaction: (f: (tx: unknown) => Promise<T>) => Promise<T>;
    };
    return pgDb.transaction((tx: unknown) => fn(factory(tx)));
  }

  function snapshotState(ship: ShipRow) {
    return {
      hull: ship.hull,
      shields: ship.shields,
      position: ship.position,
      velocity: ship.velocity,
      state: ship.state,
    };
  }

  /** Write every dirty ship + node states through one transaction. */
  async function flushDirty(nodeStates: NodeStateInput[]): Promise<number> {
    const ids = [...dirty];
    if (ids.length === 0 && nodeStates.length === 0) return 0;
    return withTransaction(async (txRepo) => {
      let n = 0;
      for (const id of ids) {
        const ship = shipCache.get(id);
        if (!ship) {
          dirty.delete(id);
          continue;
        }
        const row = await txRepo.saveShipState(id, snapshotState(ship));
        lastHull.set(id, row.hull);
        n += 1;
      }
      for (const s of nodeStates) {
        await txRepo.upsertNodeState(s.nodeId, s.quantityRemaining, s.respawnAt ?? null);
      }
      return n;
    });
  }

  const service: PersistService = {
    markDirty(ship) {
      dirty.add(ship.id);
      shipCache.set(ship.id, ship);
    },

    isDirty(shipId) {
      return dirty.has(shipId);
    },

    dirtyShipIds() {
      return [...dirty];
    },

    async saveShip(ship) {
      const row = await repo.saveShipState(ship.id, snapshotState(ship));
      dirty.delete(ship.id);
      lastHull.set(ship.id, row.hull);
      return row;
    },

    async saveCargo(shipId, items) {
      if (items.length === 0) return [];
      return withTransaction(async (txRepo) => {
        const rows: CargoRow[] = [];
        for (const item of items) {
          rows.push(await txRepo.saveCargo(shipId, item.resourceType, item.quantity));
        }
        return rows;
      });
    },

    async saveNodeStates(_systemId, states) {
      if (states.length === 0) return;
      await withTransaction(async (txRepo) => {
        for (const s of states) {
          await txRepo.upsertNodeState(s.nodeId, s.quantityRemaining, s.respawnAt ?? null);
        }
      });
    },

    async loadSystemState(systemId, nodeIds) {
      const ships = await repo.listShipsInSystem(systemId);
      const shipIds = ships.map((s) => s.id);
      const [cargo, nodeStates] = await Promise.all([
        repo.listCargo(shipIds),
        repo.listNodeStates(systemId, nodeIds),
      ]);
      const players = await repo.getPlayersByIds([...new Set(ships.map((s) => s.ownerId))]);
      const credits: Record<string, number> = {};
      for (const p of players) credits[p.id] = p.credits;
      return { systemId, ships, cargo, nodeStates, credits };
    },

    async onDock(ship) {
      return service.saveShip(ship);
    },

    async onDamage(ship) {
      const prev = lastHull.get(ship.id);
      if (prev === undefined) {
        lastHull.set(ship.id, ship.hull);
        return false;
      }
      const crossed = (HULL_MILESTONES as readonly number[]).some(
        (m) => prev > m && ship.hull <= m,
      );
      if (!crossed) return false;
      await service.saveShip(ship);
      return true;
    },

    async saveDirty() {
      if (dirty.size === 0) return { saved: 0, ms: 0 }; // no work, no transaction
      const t0 = performance.now();
      const saved = await flushDirty([]);
      dirty.clear();
      return { saved, ms: performance.now() - t0 };
    },

    async onShardShutdown(_systemId, nodeStates = []) {
      const t0 = performance.now();
      const saved = await flushDirty(nodeStates);
      dirty.clear();
      return { saved, ms: performance.now() - t0 };
    },

    lastSavedHull(shipId) {
      return lastHull.get(shipId);
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        void service.saveDirty().catch((err: unknown) => options.onError?.(err));
      }, intervalMs);
      if (options.unrefTimer ?? true) timer.unref?.();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  if (options.autoStart) service.start();
  return service;
}

/** Process-wide service backed by the default db handle and repository. */
let shared: PersistService | null = null;

export function getPersistService(): PersistService {
  if (!shared) {
    const handle = getDb();
    const tables = handle.driver === 'sqlite' ? sqliteTables : pgTables;
    shared = createPersistService({ handle, repo: createRepo(handle.db, tables) });
  }
  return shared;
}

// Module-level convenience wrappers over the process-wide service.
export function saveShip(ship: ShipRow): Promise<ShipRow> {
  return getPersistService().saveShip(ship);
}

export function saveCargo(shipId: string, items: CargoItemInput[]): Promise<CargoRow[]> {
  return getPersistService().saveCargo(shipId, items);
}

export function saveNodeStates(systemId: string, states: NodeStateInput[]): Promise<void> {
  return getPersistService().saveNodeStates(systemId, states);
}

export function loadSystemState(systemId: string, nodeIds?: string[]): Promise<SystemState> {
  return getPersistService().loadSystemState(systemId, nodeIds);
}
