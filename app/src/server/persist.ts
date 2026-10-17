/**
 * Drift persistence service (TASK-63).
 *
 * Sits one layer above the `Repository` and owns all "save point" logic:
 *
 *   - Dock landings                     → `onDock(ship)`
 *   - Hull dropping across 75/50/25%    → `onDamage(ship)`
 *   - Periodic dirty-set flush          → `startIntervalSave()` (5 s tick)
 *   - Shard exit / server shutdown      → `onShardShutdown(systemId)`
 *
 * Writes always go through the `Repository` so the SQLite and Postgres
 * implementations stay interchangeable. The service tracks a per-ship dirty
 * patch; the interval timer flushes the dirty set inside one DB transaction
 * per ship, so a server kill at any moment loses at most the most recent
 * 5 s of telemetry. Ship-level mutations at every save point clear their
 * dirty flag so the next interval sweep skips clean ships entirely.
 *
 * Crash-recovery semantics (acceptance criteria):
 *
 *   - `loadSystemState(systemId)` round-trips everything `saveShip` /
 *     `saveCargo` / `saveNodeStates` recently wrote, so a `kill -9` mid-
 *     sim loses nothing durable.
 *   - The exposed primitives (`saveShip`, `saveCargo`, `saveNodeStates`,
 *     `loadSystemState`) are the only public persistence surface; the
 *     dirty-flag / save-point hooks are an internal detail on top.
 */
import {
  type CargoItemInput,
  type CargoItemRow,
  type PlayerRow,
  type ResourceNodeStateRow,
  type SaveShipStateInput,
  type ShipPosition,
  type ShipRow,
  type ShipLivery,
  type ShipState,
  type ShipVelocity,
  type UpsertNodeStateInput,
} from "./db/types.js";
import type { Repository } from "./db/repo.js";

/**
 * Hull-percentage thresholds where a damage event is durable enough to
 * warrant a synchronous save. Crossing DOWN through any of these values
 * (`prevHull > threshold && currHull <= threshold`) triggers
 * `onDamage` to push the ship through `saveShip`.
 */
export const DAMAGE_MILESTONES: readonly number[] = [75, 50, 25] as const;

/** Default interval between dirty-set flushes (PRD §8 / TASK-63 AC2). */
export const DEFAULT_INTERVAL_MS = 5_000;

/** The persisted shape returned by `loadSystemState()`. */
export interface SystemState {
  readonly systemId: string;
  /** Resource-node states currently scoped to this system. */
  readonly nodes: ResourceNodeStateRow[];
  /** Ships whose persisted `position.systemId` matches this system. */
  readonly ships: ShipRow[];
  /** Flat list of every cargo row for ships in this system. */
  readonly cargo: CargoItemRow[];
  /** Per-player credits for owners with a ship currently in this system. */
  readonly credits: Array<{ readonly playerId: string; readonly credits: number }>;
}

/** A partial ship-state patch (the mutable surface area from `SaveShipStateInput`). */
export type MutableShipPatch = Omit<SaveShipStateInput, never>;

/** Optional configuration bag for the service constructor. */
export interface PersistServiceOptions {
  /** Override the default 5 s interval (useful in tests). */
  intervalMs?: number;
  /** Plain-Text console logger, mostly for tests. */
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * PersistService — the single, coordinated entry point for everything that
 * mutates durable game state. Composed by the server boot path
 * (`src/server/index.ts`); held in module-level state for the lifetime of
 * the process.
 *
 * Designed to be cheap to instantiate in tests: a fresh
 * `new PersistService(repo, { intervalMs: 50_000 })` is the standard
 * pattern for unit tests since the timer is `unref()`-ed and `clearInterval`
 * happens via `stopIntervalSave()` or `dispose()`.
 */
export class PersistService {
  private readonly repo: Repository;
  private readonly intervalMs: number;
  private readonly log: Pick<Console, "info" | "warn" | "error">;
  /**
   * Pending ship patches awaiting their next save. Keyed by ship id so a
   * partial dirty patch merges cleanly with later ones. Cleared after each
   * successful write (manual save, interval flush, or shard shutdown).
   */
  private readonly dirtyShips = new Map<string, MutableShipPatch>();
  /** Last-known hull percentage per ship, used to detect 75/50/25 crossings. */
  private readonly lastHullByShip = new Map<string, number>();
  /** Active interval flush timer (or `null` when stopped). */
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracked so disposal can be observed by tests. */
  private disposed = false;

  constructor(repo: Repository, options: PersistServiceOptions = {}) {
    this.repo = repo;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.log = options.logger ?? console;
  }

  // -----------------------------------------------------------------------
  // Save primitives — every public API in this block is a single
  // repository call (and therefore a single DB transaction under the hood).
  // -----------------------------------------------------------------------

  /**
   * Persist a full ship state. The dirty flag for this ship id (if any) is
   * cleared on success — `saveShip` is the canonical flush path so a
   * subsequent interval sweep skips ships we already wrote explicitly.
   */
  async saveShip(ship: ShipRow): Promise<ShipRow> {
    const patch: SaveShipStateInput = {
      hull: ship.hull,
      shields: ship.shields,
      position: ship.position,
      velocity: ship.velocity,
      state: ship.state,
      livery: ship.livery,
    };
    const saved = await this.repo.saveShipState(ship.id, patch);
    this.dirtyShips.delete(ship.id);
    this.lastHullByShip.set(ship.id, saved.hull);
    return saved;
  }

  /**
   * Persist the cargo manifest for a ship. Each call goes through one
   * `saveCargo` repository call — the SQLite repo wraps the multi-row
   * wipe-and-replace in a `BEGIN ... COMMIT` so a crash mid-save leaves
   * the prior manifest intact.
   */
  async saveCargo(shipId: string, items: CargoItemInput[]): Promise<CargoItemRow[]> {
    return this.repo.saveCargo(shipId, items);
  }

  /**
   * Upsert resource-node state for a single system. Multiple states are
   * handled here one at a time so a partially-applied upsert list leaves a
   * consistent (smaller) prefix rather than a torn state — the
   * performance budget (TASK-63 AC4) is generous enough that this is the
   * trade-off we accept.
   */
  async saveNodeStates(
    systemId: string,
    states: UpsertNodeStateInput[],
  ): Promise<ResourceNodeStateRow[]> {
    const rows: ResourceNodeStateRow[] = [];
    for (const s of states) {
      const row = await this.repo.upsertNodeState({ ...s, systemId });
      rows.push(row);
    }
    return rows;
  }

  /**
   * Resolve the persisted state for a system — used both at shard spawn
   * (warm cache) and during crash recovery. Returns nodes + ships + cargo
   * + per-owner credits so the caller can fully reconstruct the world.
   */
  async loadSystemState(systemId: string): Promise<SystemState> {
    const [nodes, ships] = await Promise.all([
      this.repo.listNodeStates(systemId),
      this.repo.listShipsBySystem(systemId),
    ]);
    const cargoNested = await Promise.all(ships.map((s) => this.repo.listCargoByShip(s.id)));
    const cargo = cargoNested.flat();
    const playerIds = new Set(ships.map((s) => s.ownerId));
    const credits = await Promise.all(
      [...playerIds].map(async (pid) => {
        try {
          const value = await this.repo.getBalance(pid);
          return { playerId: pid, credits: value };
        } catch {
          // Player row may have been deleted (test cleanup). Skip silently;
          // production callers should log externally.
          return null;
        }
      }),
    );
    return {
      systemId,
      nodes,
      ships,
      cargo,
      credits: credits.filter((c): c is { playerId: string; credits: number } => c !== null),
    };
  }

  // -----------------------------------------------------------------------
  // Dirty-flag management — the interval save uses this set as its queue.
  // -----------------------------------------------------------------------

  /**
   * Mark a ship dirty with a partial patch. Subsequent `markDirty()` calls
   * for the same id merge fields shallowly so a tick that updates hull +
   * position only triggers one save on the next interval.
   */
  markDirty(shipId: string, patch: MutableShipPatch): void {
    const existing = this.dirtyShips.get(shipId);
    if (existing === undefined) {
      this.dirtyShips.set(shipId, { ...patch });
    } else {
      this.dirtyShips.set(shipId, { ...existing, ...patch });
    }
  }

  /** True if a pending patch exists for the given ship id. */
  isDirty(shipId: string): boolean {
    return this.dirtyShips.has(shipId);
  }

  /** Visible-for-test size of the dirty set. */
  dirtySize(): number {
    return this.dirtyShips.size;
  }

  /** Visibly-clear every dirty flag. Tests use this to validate interval skipping. */
  clearDirty(): void {
    this.dirtyShips.clear();
  }

  /** Read-only snapshot of the dirty map (for tests / instrumentation). */
  dirtySnapshot(): ReadonlyMap<string, MutableShipPatch> {
    return new Map(this.dirtyShips);
  }

  // -----------------------------------------------------------------------
  // Save points — the four hooks required by TASK-63 AC2.
  // -----------------------------------------------------------------------

  /**
   * Save point: a ship has docked. Pushes the ship state through `saveShip`
   * so `state` is durable + the dirty flag (if any) is cleared.
   *
   * Cargo is intentionally NOT included here — the caller invokes
   * `saveCargo(...)` separately when the manifest changes, matching how the
   * sim logically separates "we're docked" from "cargo transferred".
   */
  async onDock(ship: ShipRow): Promise<ShipRow> {
    return this.saveShip({ ...ship, state: "docked" satisfies ShipState });
  }

  /**
   * Save point: a ship took damage. If the hull crossed DOWN through one
   * of the 75/50/25% milestones, the ship state is pushed to disk
   * synchronously. The return value indicates whether a save fired so
   * tests / observability can track milestone hits.
   */
  async onDamage(ship: ShipRow): Promise<boolean> {
    const prevHull = this.lastHullByShip.get(ship.id);
    // Always remember the new hull so subsequent calls have a baseline.
    this.lastHullByShip.set(ship.id, ship.hull);
    if (prevHull === undefined) {
      // First contact: nothing to compare against, no save fires.
      return false;
    }
    for (const threshold of DAMAGE_MILESTONES) {
      if (prevHull > threshold && ship.hull <= threshold) {
        await this.saveShip(ship);
        return true;
      }
    }
    return false;
  }

  /**
   * Start the periodic dirty-set flush. Idempotent: calling twice returns
   * the existing timer. The interval `unref()`s so a running flush loop
   * never keeps the process alive on its own (server shutdown is the
   * trigger path).
   */
  startIntervalSave(): ReturnType<typeof setInterval> {
    if (this.intervalTimer !== null) return this.intervalTimer;
    const timer = setInterval(() => {
      void this.flushDirtyShips().catch((err: unknown) => {
        this.log.error("[persist] interval flush failed:", err);
      });
    }, this.intervalMs);
    // Don't prevent process exit while idle.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.intervalTimer = timer;
    return timer;
  }

  /** Stop the interval save. Safe to call when no timer is running. */
  stopIntervalSave(): void {
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Drain every dirty ship through `saveShipState`. Returns the number of
   * ships saved. Each save is one row UPDATE (single SQL statement, one
   * journal commit under SQLite WAL).
   */
  async flushDirtyShips(): Promise<number> {
    const entries = Array.from(this.dirtyShips.entries());
    for (const [id, patch] of entries) {
      if (this.isEmptyPatch(patch)) {
        // An entirely-undefined patch is a no-op — drop it without an I/O.
        this.dirtyShips.delete(id);
        continue;
      }
      await this.repo.saveShipState(id, patch);
      this.dirtyShips.delete(id);
    }
    return entries.length;
  }

  /** Save point: shard is shutting down. Flush dirty ships + persist registry state. */
  async onShardShutdown(systemId: string): Promise<void> {
    await this.flushDirtyShips();
    await this.repo.upsertSystemRegistry({
      systemId,
      name: systemId,
      shardActive: false,
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle — tests call `dispose()` so the interval timer doesn't leak.
  // -----------------------------------------------------------------------

  /** Stop the timer and mark the service as disposed. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.stopIntervalSave();
    this.dirtyShips.clear();
    this.lastHullByShip.clear();
    this.disposed = true;
  }

  /** Has the service been disposed? Useful for `assert(!svc.disposed)`. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Currently configured interval (ms). */
  get configuredIntervalMs(): number {
    return this.intervalMs;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private isEmptyPatch(patch: MutableShipPatch): boolean {
    return (
      patch.hull === undefined &&
      patch.shields === undefined &&
      patch.position === undefined &&
      patch.velocity === undefined &&
      patch.state === undefined &&
      patch.livery === undefined
    );
  }
}

/**
 * Helper exported for tests that prefer to construct the patch directly
 * without re-typing every field.
 */
export function emptyMutablePatch(): MutableShipPatch {
  return {};
}

/**
 * Convenience: construct a `ShipRow`-shaped object suitable for `saveShip`.
 * Centralised so test fixtures and the server boot path agree on the
 * canonical shape (e.g. velocity is always an object, never undefined).
 */
export function materialiseShip(input: {
  id: string;
  ownerId: string;
  classId: ShipRow["classId"];
  livery: ShipLivery;
  hull: number;
  shields: number;
  position: ShipPosition;
  velocity?: ShipVelocity;
  state?: ShipState;
}): ShipRow {
  const velocity = input.velocity ?? { x: 0, y: 0, z: 0 };
  return {
    id: input.id,
    ownerId: input.ownerId,
    classId: input.classId,
    livery: input.livery,
    hull: input.hull,
    shields: input.shields,
    position: input.position,
    velocity,
    state: input.state ?? "docked",
    // The `updatedAt` is overwritten by `saveShipState` so this value is
    // only used by callers that want a synthetic timestamp for tests.
    updatedAt: new Date(0),
  };
}

/**
 * Tiny smoke helper: assert the persist service was constructed with a real
 * repository. Use sparingly — most consumers should not need this guard.
 */
export function assertRepoShape(repo: unknown): asserts repo is Repository {
  if (
    typeof repo !== "object" ||
    repo === null ||
    typeof (repo as { saveShipState?: unknown }).saveShipState !== "function"
  ) {
    throw new Error("PersistService requires a Repository-compatible object");
  }
}

// Re-export common types so callers can `import { … } from "@server/persist"`.
export type {
  CargoItemInput,
  CargoItemRow,
  PlayerRow,
  ResourceNodeStateRow,
  SaveShipStateInput,
  ShipLivery,
  ShipPosition,
  ShipRow,
  ShipState,
  ShipVelocity,
  UpsertNodeStateInput,
};
