import { shipStats } from '@shared/ships/catalog.ts';
import { NotFoundError } from './db/errors.ts';
import type { Repository, CargoItem, NodeState } from './db/types.ts';
import { damageLevel } from './persist/hull.ts';
import { realScheduler } from './persist/scheduler.ts';
import type { FlushResult, LiveShip, PersistOptions, SystemState } from './persist/types.ts';

export type { LiveShip, SystemState, FlushResult, PersistOptions } from './persist/types.ts';

const DEFAULT_INTERVAL_MS = 5000;

interface DirtyShip {
  ship: LiveShip;
  version: number;
}

interface DirtyNode {
  state: NodeState;
  version: number;
}

/** Canonical key of a hold, used to skip rewriting unchanged cargo. */
function cargoKey(items: readonly CargoItem[]): string {
  const sorted = [...items].sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  return JSON.stringify(sorted.map((i) => [i.resourceType, i.quantity]));
}

/** Copies the mutable parts of a live ship so later sim mutation cannot change a queued save. */
function snapshot(ship: LiveShip): LiveShip {
  return {
    ...ship,
    position: { ...ship.position },
    velocity: { ...ship.velocity },
    ...(ship.livery ? { livery: { ...ship.livery } } : {}),
    ...(ship.cargo ? { cargo: ship.cargo.map((item) => ({ ...item })) } : {}),
  };
}

/**
 * Saves mutable game state at defined save points and loads it on shard spawn. All writes go
 * through the repository, one transaction per save point (never per field):
 * - `onDock` and a damage milestone (hull crossing 75/50/25%) save immediately;
 * - `markDirty` queues a ship for the interval save (default every 5 s), which writes every
 *   dirty ship in a single transaction and does nothing at all when nothing is dirty;
 * - `onShardShutdown` / `shutdown` flush what is still dirty.
 * A failed flush keeps its ships dirty and retries on the next interval.
 */
export function createPersistService(repo: Repository, options: PersistOptions = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const scheduler = options.scheduler ?? realScheduler;
  const clock = options.clock ?? ((): number => performance.now());
  const onError = options.onError ?? ((): void => undefined);

  const dirtyShips = new Map<string, DirtyShip>();
  const dirtyNodes = new Map<string, DirtyNode>();
  const savedCargo = new Map<string, string>();
  const damageLevels = new Map<string, number>();
  let version = 0;
  let timer: unknown;
  let chain: Promise<unknown> = Promise.resolve();
  let ticking = false;

  /** Serialises save operations so two transactions never overlap. */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = chain.then(work);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Writes the given ships and nodes in one transaction and clears their dirty flags, unless
   * they were re-marked while the write was in flight. Ships deleted from the database are
   * dropped (and reported) so one bad row can never block everyone else's saves.
   */
  async function write(
    entries: DirtyShip[],
    nodes: { systemId: string; entry: DirtyNode }[],
    dropMissing: boolean,
  ): Promise<FlushResult> {
    const started = clock();
    const cargoKeys = new Map<string, string>();
    const snapshots = entries.map(({ ship }) => {
      let cargo: readonly CargoItem[] | undefined;
      if (ship.cargo) {
        const key = cargoKey(ship.cargo);
        cargoKeys.set(ship.shipId, key);
        if (savedCargo.get(ship.shipId) !== key) cargo = ship.cargo;
      }
      return {
        shipId: ship.shipId,
        update: {
          hull: ship.hull,
          shields: ship.shields,
          position: ship.position,
          velocity: ship.velocity,
          state: ship.state,
          ...(ship.livery ? { livery: ship.livery } : {}),
        },
        ...(cargo ? { cargo } : {}),
      };
    });
    let result = { saved: [] as string[], missing: [] as string[] };
    await repo.transaction(async (tx) => {
      result = await tx.saveShipSnapshots(snapshots);
      if (nodes.length > 0) await tx.upsertNodeStates(nodes.map(({ entry }) => entry.state));
    });

    const savedIds = new Set(result.saved);
    const saved = entries.filter((entry) => savedIds.has(entry.ship.shipId));
    const missing = entries.filter((entry) => result.missing.includes(entry.ship.shipId));
    for (const entry of saved) {
      const key = cargoKeys.get(entry.ship.shipId);
      if (key !== undefined) savedCargo.set(entry.ship.shipId, key);
      if (dirtyShips.get(entry.ship.shipId)?.version === entry.version) {
        dirtyShips.delete(entry.ship.shipId);
      }
    }
    for (const entry of missing) {
      dirtyShips.delete(entry.ship.shipId);
      const error = new NotFoundError('ship', entry.ship.shipId);
      if (!dropMissing) throw error;
      onError(error);
    }
    for (const { entry } of nodes) {
      if (dirtyNodes.get(entry.state.nodeId)?.version === entry.version) {
        dirtyNodes.delete(entry.state.nodeId);
      }
    }
    return { ships: saved.length, nodes: nodes.length, durationMs: clock() - started };
  }

  /** Flushes dirty ships/nodes accepted by the filters, as one queued transaction. */
  function flush(
    shipFilter: (ship: LiveShip) => boolean,
    nodeFilter: (systemId: string) => boolean,
  ): Promise<FlushResult> {
    return enqueue(() => {
      const ships = [...dirtyShips.values()].filter((entry) => shipFilter(entry.ship));
      const nodes = [...dirtyNodes.values()]
        .filter((entry) => nodeFilter(entry.state.systemId))
        .map((entry) => ({ systemId: entry.state.systemId, entry }));
      if (ships.length === 0 && nodes.length === 0) {
        return Promise.resolve({ ships: 0, nodes: 0, durationMs: 0 });
      }
      return write(ships, nodes, true);
    });
  }

  /** Saves one ship immediately (state, and its hold when provided) in one transaction. */
  function saveShip(ship: LiveShip): Promise<void> {
    const entry: DirtyShip = { ship: snapshot(ship), version: ++version };
    dirtyShips.set(ship.shipId, entry);
    return enqueue(() => write([entry], [], false)).then(() => undefined);
  }

  const service = {
    saveShip,

    /** Replaces a ship's hold now (one transaction). */
    async saveCargo(shipId: string, items: readonly CargoItem[]): Promise<void> {
      await enqueue(async () => {
        await repo.saveCargo(shipId, items);
        savedCargo.set(shipId, cargoKey(items));
      });
    },

    /** Upserts node states of one system now (one transaction). */
    async saveNodeStates(
      systemId: string,
      states: readonly Omit<NodeState, 'systemId'>[],
    ): Promise<void> {
      await enqueue(() => repo.upsertNodeStates(states.map((s) => ({ ...s, systemId }))));
    },

    /** Starts tracking a ship's damage level (call on spawn/load) without saving. */
    track(ship: LiveShip): void {
      damageLevels.set(ship.shipId, damageLevel(ship.hull, shipStats(ship.classId).hull));
    },

    /** Queues the ship's latest state for the next interval save. */
    markDirty(ship: LiveShip): void {
      dirtyShips.set(ship.shipId, { ship: snapshot(ship), version: ++version });
    },

    /** Queues a node's latest state (e.g. depleted) for the next interval save. */
    markNodeDirty(state: NodeState): void {
      dirtyNodes.set(state.nodeId, { state: { ...state }, version: ++version });
    },

    /** Save point: the ship docked. Saves state and hold immediately. */
    onDock(ship: LiveShip): Promise<void> {
      return saveShip(ship);
    },

    /**
     * Save point: the ship took (or recovered from) damage. Always queues the interval save;
     * saves immediately and returns true when hull newly crosses a 75/50/25% threshold.
     */
    async onDamage(ship: LiveShip): Promise<boolean> {
      const level = damageLevel(ship.hull, shipStats(ship.classId).hull);
      const previous = damageLevels.get(ship.shipId) ?? 0;
      damageLevels.set(ship.shipId, level);
      if (level > previous) {
        await saveShip(ship);
        return true;
      }
      service.markDirty(ship);
      return false;
    },

    /** Interval body: saves every dirty ship and node in one transaction. */
    flushDirty: (): Promise<FlushResult> =>
      flush(
        () => true,
        () => true,
      ),

    /** Save point: a shard is shutting down; saves what is still dirty in that system. */
    onShardShutdown: (systemId: string): Promise<FlushResult> =>
      flush(
        (ship) => ship.position.systemId === systemId,
        (id) => id === systemId,
      ),

    /** Starts the interval save (idempotent). */
    start(): void {
      if (timer !== undefined) return;
      timer = scheduler.setInterval(() => {
        if (ticking) return;
        ticking = true;
        service
          .flushDirty()
          .catch(onError)
          .finally(() => {
            ticking = false;
          });
      }, intervalMs);
    },

    /** Stops the interval save without flushing. */
    stop(): void {
      if (timer === undefined) return;
      scheduler.clearInterval(timer);
      timer = undefined;
    },

    /** Process shutdown: stops the timer, then flushes everything still dirty. */
    async shutdown(): Promise<FlushResult> {
      service.stop();
      return service.flushDirty();
    },

    /** Loads the persisted ships (with holds) and node states for a shard spawn. */
    async loadSystemState(systemId: string): Promise<SystemState> {
      const ships = await repo.listShipsInSystem(systemId);
      const [holds, nodeStates] = await Promise.all([
        repo.getCargoForShips(ships.map((s) => s.id)),
        repo.listNodeStates(systemId),
      ]);
      const withCargo = ships.map((ship) => {
        const cargo = holds.get(ship.id) ?? [];
        savedCargo.set(ship.id, cargoKey(cargo));
        damageLevels.set(ship.id, damageLevel(ship.hull, shipStats(ship.classId).hull));
        return { ...ship, cargo };
      });
      return { systemId, ships: withCargo, nodeStates };
    },

    /** Counters for diagnostics and tests. */
    stats: () => ({ dirtyShips: dirtyShips.size, dirtyNodes: dirtyNodes.size }),
    isDirty: (shipId: string): boolean => dirtyShips.has(shipId),
  };
  return service;
}

export type PersistService = ReturnType<typeof createPersistService>;
