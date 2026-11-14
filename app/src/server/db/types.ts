import type { ShipClassId } from '@shared/ships/ids.ts';
import type { Livery, Position, Velocity } from './json.ts';
import type { ShipState } from './schema.ts';

export interface Player {
  id: string;
  callsign: string;
  credits: number;
  homeSystemId: string;
  createdAt: Date;
}

export interface Ship {
  id: string;
  ownerId: string;
  classId: ShipClassId;
  livery: Livery;
  hull: number;
  shields: number;
  position: Position;
  velocity: Velocity;
  state: ShipState;
  updatedAt: Date;
}

/** A full snapshot of a ship's mutable state, as written by saveShipState. */
export interface ShipStateUpdate {
  hull: number;
  shields: number;
  position: Position;
  velocity: Velocity;
  state: ShipState;
  livery?: Livery;
}

export interface CargoItem {
  resourceType: string;
  quantity: number;
}

export interface Session {
  tokenHash: string;
  playerId: string;
  systemId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface NodeState {
  nodeId: string;
  systemId: string;
  quantityRemaining: number;
  respawnAt: Date | null;
}

export interface SystemRecord {
  systemId: string;
  name: string;
  shardActive: boolean;
  lastActiveAt: Date | null;
}

export interface PlayersRepo {
  createPlayer(input: {
    callsign: string;
    homeSystemId: string;
    credits?: number;
  }): Promise<Player>;
  findPlayerByCallsign(callsign: string): Promise<Player | undefined>;
  getPlayer(id: string): Promise<Player | undefined>;
  /** Atomically adds credits; returns the new balance. */
  addCredits(playerId: string, amount: number): Promise<number>;
  /** Atomically withdraws credits (never below zero); returns the new balance. */
  withdrawCredits(playerId: string, amount: number): Promise<number>;
}

export interface ShipsRepo {
  /** Returns the player's existing non-destroyed scout, or creates a docked starter scout. */
  getOrCreateStarterShip(playerId: string): Promise<Ship>;
  getShip(id: string): Promise<Ship | undefined>;
  listShipsByOwner(ownerId: string): Promise<Ship[]>;
  /** Ships whose position is in `systemId`, excluding destroyed ones. */
  listShipsInSystem(systemId: string): Promise<Ship[]>;
  saveShipState(shipId: string, update: ShipStateUpdate): Promise<Ship>;
}

export interface CargoRepo {
  /** Replaces the ship's whole hold; zero-quantity entries are removed. */
  saveCargo(shipId: string, items: readonly CargoItem[]): Promise<void>;
  getCargo(shipId: string): Promise<CargoItem[]>;
  /** Cargo for many ships in one query, keyed by ship id. */
  getCargoForShips(shipIds: readonly string[]): Promise<Map<string, CargoItem[]>>;
}

/** One ship's save: its state and, when provided, its whole hold. */
export interface ShipSnapshot {
  shipId: string;
  update: ShipStateUpdate;
  cargo?: readonly CargoItem[];
}

export interface SnapshotsRepo {
  /**
   * Saves many ships (state, plus holds where given) in ONE transaction without re-reading rows.
   * Returns the ids saved and the ids that no longer exist (skipped, not an error).
   */
  saveShipSnapshots(
    snapshots: readonly ShipSnapshot[],
  ): Promise<{ saved: string[]; missing: string[] }>;
}

export interface SessionsRepo {
  createSession(input: {
    tokenHash: string;
    playerId: string;
    systemId?: string | null;
    expiresAt: Date;
  }): Promise<Session>;
  getSession(tokenHash: string): Promise<Session | undefined>;
  setSessionSystem(tokenHash: string, systemId: string | null): Promise<void>;
  deleteSession(tokenHash: string): Promise<boolean>;
  deleteSessionsForPlayer(playerId: string): Promise<number>;
  /** Deletes sessions that expired at or before `now`; returns how many. */
  deleteExpiredSessions(now: Date): Promise<number>;
}

export interface NodeStateRepo {
  upsertNodeState(state: NodeState): Promise<void>;
  /** Upserts many states in one statement per chunk. */
  upsertNodeStates(states: readonly NodeState[]): Promise<void>;
  listNodeStates(systemId: string): Promise<NodeState[]>;
}

export interface SystemRegistryRepo {
  upsertSystem(input: { systemId: string; name: string }): Promise<SystemRecord>;
  getSystem(systemId: string): Promise<SystemRecord | undefined>;
  /** Flags a shard active/inactive and stamps last_active_at; throws NotFoundError if unknown. */
  setShardActive(systemId: string, active: boolean): Promise<SystemRecord>;
}

/** The full async repository; identical for SQLite and Postgres. */
export interface Repository
  extends
    PlayersRepo,
    ShipsRepo,
    CargoRepo,
    SnapshotsRepo,
    SessionsRepo,
    NodeStateRepo,
    SystemRegistryRepo {
  /** Runs `fn` against a repository bound to one transaction (rolled back if `fn` rejects). */
  transaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T>;
}
