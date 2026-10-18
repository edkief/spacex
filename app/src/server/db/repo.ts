/**
 * Repository abstraction over the Drift persistence layer.
 *
 * Exposes the `Repository` interface every consumer in the codebase
 * depends on, plus the small set of default constants and the
 * `createRepository()` factory that selects the correct driver
 * implementation. The two driver-specific implementations live in:
 *
 *   - `./repo.sqlite.ts`  — better-sqlite3 (default local driver)
 *   - `./repo.pg.ts`      — node-postgres (`DB_DRIVER=postgres`)
 *
 * Both satisfy `Repository` byte-for-byte; the only differences are
 * column-type literals (`text` vs `uuid`, `boolean` integer mode vs
 * native boolean, etc.) and the way rows are read back (SQLite returns
 * strings for timestamps, Postgres returns native `Date` objects).
 *
 * Driver errors (`UNIQUE` / `23505`) are funneled through
 * `mapUniqueViolation()` and re-thrown as typed `CallsignTakenError`s so
 * callers can branch without matching on raw error messages.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type sqliteSchema } from "./schema.sqlite.js";
import { type pgSchema } from "./schema.pg.js";
import { CallsignTakenError, InsufficientCreditsError, NotFoundError } from "./errors.js";
import type { Inventory } from "@shared/world/inventory.js";
import type {
  CargoItemInput,
  CargoItemRow,
  CreatePlayerInput,
  CreateSessionInput,
  PlayerRow,
  ResourceNodeStateRow,
  SaveShipStateInput,
  SessionRow,
  ShipClassId,
  ShipLivery,
  ShipPosition,
  ShipRow,
  ShipVelocity,
  SystemRegistryRow,
  UpsertNodeStateInput,
} from "./types.js";
import { createSqliteRepository } from "./repo.sqlite.js";
import { createPgRepository } from "./repo.pg.js";

/** Re-export shared helpers so callers have a single import path. */
export { CallsignTakenError, InsufficientCreditsError, NotFoundError } from "./errors.js";
export type {
  CargoItemInput,
  CargoItemRow,
  CreatePlayerInput,
  CreateSessionInput,
  PlayerRow,
  ResourceNodeStateRow,
  SaveShipStateInput,
  SessionRow,
  ShipClassId,
  ShipPosition,
  ShipRow,
  ShipVelocity,
  ShipLivery,
  SystemRegistryRow,
  UpsertNodeStateInput,
} from "./types.js";

/** Convenience input for `createSystemRegistry` callers. */
export interface CreateSystemRegistryInput {
  systemId: string;
  name: string;
  shardActive: boolean;
}

/**
 * Slim "credit row" projection returned by transaction-bound helpers.
 * Avoids the cost of mapping a full `PlayerRow` when the callback only
 * needs `{ id, credits }` (e.g. the dock-sell flow in TASK-40).
 */
export type PlayerCreditSlice = {
  id: string;
  credits: number;
};

/**
 * Driver-agnostic ship replacement handle (TASK-20).
 *
 * Exposed to a `runInTransaction` callback by both the SQLite and the
 * Postgres repository. Lets the caller delete the player's current
 * ship (cascade-deleting cargo) and insert a fresh row for a new
 * class, all atomically with the credit withdraw.
 */
export interface ShipReplacementHandle {
  /**
   * Replace the player's currently-owned ship. The old ship row is
   * deleted (with its `cargo_items` via cascade) and a new row is
   * inserted for the given class. The new ship is returned so the
   * caller can emit follow-up broadcasts (TASK-20).
   *
   * The replacement is synchronous with respect to the open
   * transaction; throwing here rolls back everything the callback did.
   */
  replaceOwnedShip: (playerId: string, classId: ShipClassId) => ShipRow;
}

/**
 * Synchronous transaction-handle type used by the SQLite repository's
 * `runInTransaction` helper. Composes the credit helpers (TASK-41)
 * with the ship-replacement helper (TASK-20).
 */
export interface SqliteRepositoryTransaction extends ShipReplacementHandle {
  addCredits: (playerId: string, amount: number) => PlayerCreditSlice;
  withdrawCredits: (playerId: string, amount: number) => PlayerCreditSlice;
}

/**
 * Repository contract — both driver implementations satisfy this shape.
 *
 * Every method either returns the requested row(s) or throws one of the
 * typed errors exported from `./errors.ts`. Driver-level transient
 * failures (lost connection, etc.) propagate to the caller; we don't
 * try to paper over them.
 */
export interface Repository {
  // Players
  createPlayer(input: CreatePlayerInput): Promise<PlayerRow>;
  findPlayerByCallsign(callsign: string): Promise<PlayerRow | null>;
  findPlayerById(id: string): Promise<PlayerRow | null>;

  // Inventory (TASK-34)
  /**
   * Load the persisted on-foot inventory for a single player.
   * Returns the empty inventory for pre-TASK-34 rows (the
   * column is nullable). Throws `NotFoundError` for unknown
   * players — callers should branch on the explicit error.
   */
  getInventory(playerId: string): Promise<Inventory>;
  /**
   * Replace the persisted inventory wholesale. The shard
   * treats the player's inventory as a write-on-mutation value
   * (every pickup / drop triggers a save) so a delta-update API
   * isn't necessary in v1. The valid shape is the one returned
   * by `addToInventory` / `removeFromInventory` in
   * `@shared/world/inventoryOps`.
   */
  saveInventory(playerId: string, inventory: Inventory): Promise<Inventory>;

  // Ships
  getOrCreateStarterShip(playerId: string, classId: ShipClassId): Promise<ShipRow>;
  findShipById(id: string): Promise<ShipRow | null>;
  saveShipState(id: string, patch: SaveShipStateInput): Promise<ShipRow>;
  listShipsByOwner(ownerId: string): Promise<ShipRow[]>;
  /** Ships whose persisted position.systemId matches the given system. */
  listShipsBySystem(systemId: string): Promise<ShipRow[]>;
  /**
   * Ships that should hydrate a freshly-spawned shard (TASK-24). Same
   * filter as `listShipsBySystem` but additionally:
   *   - excludes ships with `state === 'destroyed'` and no remaining wreck TTL
   *   - includes wrecks whose `wreckExpiresAt` is in the future so the
   *     sim can render their impostor until cleanup
   * Implementations may translate the `nowMs` value into the driver's
   * timestamp comparison format.
   */
  listLiveShipsBySystem(systemId: string, nowMs: number): Promise<ShipRow[]>;
  /**
   * Delete every `state === 'destroyed'` ship whose `wreckExpiresAt`
   * has passed (TASK-24 destruction persistence). Returns the number
   * of rows removed. Safe to call repeatedly — idempotent.
   */
  deleteExpiredWrecks(systemId: string, nowMs: number): Promise<number>;

  // Cargo
  saveCargo(shipId: string, items: CargoItemInput[]): Promise<CargoItemRow[]>;
  /** All cargo rows for a single ship, in insertion order. */
  listCargoByShip(shipId: string): Promise<CargoItemRow[]>;

  // Credits
  addCredits(playerId: string, amount: number): Promise<PlayerRow>;
  withdrawCredits(playerId: string, amount: number): Promise<PlayerRow>;
  /**
   * Read the integer credit balance. Throws `NotFoundError` if the
   * player does not exist. No default — callers should branch on the
   * explicit error instead of treating missing as zero.
   */
  getBalance(playerId: string): Promise<number>;

  // Resource node state
  upsertNodeState(input: UpsertNodeStateInput): Promise<ResourceNodeStateRow>;
  listNodeStates(systemId: string): Promise<ResourceNodeStateRow[]>;

  // Sessions
  createSession(input: CreateSessionInput): Promise<SessionRow>;
  getSession(tokenHash: string): Promise<SessionRow | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /**
   * Delete every session row whose `playerId` matches. Used by the WS
   * `logout` handler (TASK-66) for full sign-out semantics: a player
   * logging out via WS revokes *all* of their active sessions, not just
   * one, so concurrent connections on the same account all see the
   * revoke. Returns the number of rows deleted.
   */
  deleteSessionsByPlayerId(playerId: string): Promise<number>;

  // System registry
  upsertSystemRegistry(row: CreateSystemRegistryInput): Promise<SystemRegistryRow>;
  listActiveShards(): Promise<SystemRegistryRow[]>;

  // Ship purchase (TASK-20)
  /**
   * Atomic ship purchase. Validates preconditions (`currentShip.state
   * === 'docked'`, no duplicate-class purchase), withdraws the dock
   * price via the compare-and-swap credit helper, deletes the old
   * ship (cascading to cargo) and inserts a fresh ship row all
   * inside a single `BEGIN ... COMMIT`. The returned row is the new
   * ship so the caller can broadcast `entity_update`.
   *
   * Initial hull + shields + price + livery are passed in by the
   * caller (the route layer reads them off the `@shared/ships`
   * catalog). Both driver implementations throw the same typed
   * errors so the route can map them to HTTP codes:
   *
   *   - `InsufficientCreditsError` — price > current balance
   *   - `NotDockedError`            — player is mid-flight, not docked
   *   - `AlreadyOwnedShipError`     — currentShip.classId === classId
   *   - `NotFoundError`             — unknown playerId
   *
   * `@see ./errors.ts` for the typed error classes.
   */
  purchaseShip(input: {
    playerId: string;
    classId: ShipClassId;
    price: number;
    hull: number;
    shields: number;
    livery: ShipLivery;
  }): Promise<ShipRow>;

  // Ship repair (TASK-23)
  /**
   * Atomic dock repair. Validates preconditions (the player's ship
   * state is `"docked"`), withdraws `cost` credits via the
   * compare-and-swap credit helper, and restores `hull` + `shields`
   * to the class maxes, all inside a single `BEGIN ... COMMIT`. The
   * returned row is the post-repair ship so the caller can broadcast
   * `entity_update`.
   *
   * Cost calculation (`ceil((1 - hull/maxHull)*10) +
   * ceil((1 - shields/maxShields)*5)`) lives in the route layer
   * (`@shared/physics/damage.ts`). The repo enforces the
   * preconditions + the credit withdraw so a half-applied repair
   * (credits withdrawn but hull not restored, or hull restored but
   * credits not withdrawn) is impossible.
   *
   * Throws:
   *   - `NotDockedError`            — the ship is mid-flight
   *   - `InsufficientCreditsError`  — `cost > balance`
   *   - `NotFoundError`             — unknown shipId or playerId
   *
   * `@see ./errors.ts` for the typed error classes.
   */
  repairShip(input: {
    playerId: string;
    shipId: string;
    cost: number;
    maxHull: number;
    maxShields: number;
  }): Promise<ShipRow>;
}

/** Typed error thrown by `purchaseShip` when the player is mid-flight. */
export class NotDockedError extends Error {
  readonly kind = "not_docked" as const;
  constructor(public readonly playerId: string) {
    super(`Player ${playerId} is not docked; cannot purchase a ship`);
    this.name = "NotDockedError";
  }
}

/** Typed error thrown by `purchaseShip` when the player already owns that class. */
export class AlreadyOwnedShipError extends Error {
  readonly kind = "already_owned_ship" as const;
  constructor(
    public readonly playerId: string,
    public readonly classId: ShipClassId,
  ) {
    super(`Player ${playerId} already owns a ship of class ${classId}`);
    this.name = "AlreadyOwnedShipError";
  }
}

/** Canonical default livery — used by `getOrCreateStarterShip`. */
export const DEFAULT_LIVERY: ShipLivery = {
  primary: "#3aa9ff",
  secondary: "#0d3a66",
  accent: "#ffffff",
};

/** Canonical starting ship position — placed at the home system origin. */
export function defaultPosition(homeSystemId: string): ShipPosition {
  return { systemId: homeSystemId, x: 0, y: 0, z: 0 };
}

/** Canonical zero-velocity starting point. */
export const ZERO_VELOCITY: ShipVelocity = { x: 0, y: 0, z: 0 };

/** Default starter hull and shields for the starter scout (TASK-19 ships.ts). */
export const STARTER_HULL = 100;
export const STARTER_SHIELDS = 100;

/**
 * Factory that picks the right driver implementation based on `DB_DRIVER`.
 *
 * Tests that exercise only one driver should call `createSqliteRepository()`
 * (or `createPgRepository()`) directly to skip the env lookup.
 */
export function createRepository(config: {
  driver: "sqlite" | "postgres";
  db: BetterSQLite3Database<typeof sqliteSchema> | NodePgDatabase<typeof pgSchema>;
}): Repository {
  if (config.driver === "postgres") {
    return createPgRepository(config.db as NodePgDatabase<typeof pgSchema>);
  }
  return createSqliteRepository(config.db as BetterSQLite3Database<typeof sqliteSchema>);
}

// Sanity-re-export the typed errors so callers can `import { ... } from
// "./repo.js"` without a second import line.
void CallsignTakenError;
void InsufficientCreditsError;
void NotFoundError;
