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

  // Ships
  getOrCreateStarterShip(playerId: string, classId: ShipClassId): Promise<ShipRow>;
  findShipById(id: string): Promise<ShipRow | null>;
  saveShipState(id: string, patch: SaveShipStateInput): Promise<ShipRow>;
  listShipsByOwner(ownerId: string): Promise<ShipRow[]>;
  /** Ships whose persisted position.systemId matches the given system. */
  listShipsBySystem(systemId: string): Promise<ShipRow[]>;

  // Cargo
  saveCargo(shipId: string, items: CargoItemInput[]): Promise<CargoItemRow[]>;
  /** All cargo rows for a single ship, in insertion order. */
  listCargoByShip(shipId: string): Promise<CargoItemRow[]>;

  // Credits
  addCredits(playerId: string, amount: number): Promise<PlayerRow>;
  withdrawCredits(playerId: string, amount: number): Promise<PlayerRow>;
  getCredits(playerId: string): Promise<number>;

  // Resource node state
  upsertNodeState(input: UpsertNodeStateInput): Promise<ResourceNodeStateRow>;
  listNodeStates(systemId: string): Promise<ResourceNodeStateRow[]>;

  // Sessions
  createSession(input: CreateSessionInput): Promise<SessionRow>;
  getSession(tokenHash: string): Promise<SessionRow | null>;
  deleteSession(tokenHash: string): Promise<void>;

  // System registry
  upsertSystemRegistry(row: CreateSystemRegistryInput): Promise<SystemRegistryRow>;
  listActiveShards(): Promise<SystemRegistryRow[]>;
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

/** Default starter hull and shields (TASK-22 flight + TASK-23 damage tuning). */
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
