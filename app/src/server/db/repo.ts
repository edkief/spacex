import { and, eq, inArray, like, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { SHIP_CLASSES } from '@shared/ships';
import type { Db } from './client';
import {
  CallsignTakenError,
  InsufficientCreditsError,
  NotFoundError,
  isUniqueViolation,
} from './errors';
import {
  SHIP_CLASS_IDS,
  SHIP_STATES,
  type CargoRow,
  type Livery,
  type NodeStateRow,
  type PlayerRow,
  type Schema,
  type SessionRow,
  type ShipPosition,
  type ShipRow,
  type ShipState,
  type SystemRow,
  type Vec3,
} from './schema';

// zod shapes validated at the repository boundary (JSON columns)
export const Vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export const ShipPositionSchema = Vec3Schema.extend({ systemId: z.string().min(1) });
/** Strict 3-slot livery: hex colors only, no extra keys (TASK-21). */
export const LiverySchema = z
  .object({
    hull: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    trim: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();

const uuid = (): string => crypto.randomUUID();
const nowIso = (): string => new Date().toISOString();

export interface ShipStateInput {
  hull: number;
  shields: number;
  position: ShipPosition;
  velocity: Vec3;
  state: ShipState;
  /** TASK-21: full 3-slot livery; only written when provided. */
  livery?: Livery;
}

/** The class default for a known id, neutral black livery otherwise. */
function defaultLiveryFor(classId: string): Livery {
  const cls = SHIP_CLASSES[classId as keyof typeof SHIP_CLASSES];
  return cls?.defaultLivery ?? { hull: '#000000', accent: '#000000', trim: '#000000' };
}

export interface SessionInput {
  tokenHash: string;
  playerId: string;
  systemId?: string | null;
  expiresAt: string;
}

/**
 * Repository over the shared six-table schema. Written once against the
 * dialect-agnostic drizzle query-builder surface (insert/select/update/
 * delete + eq/and/inArray/like/lt), so the same code serves the sqlite and
 * postgres drivers; JSON columns are zod-validated at the boundary.
 * All queries are parameterized — no user input is concatenated into SQL.
 */
export interface Repository {
  createPlayer(input: {
    callsign: string;
    homeSystemId: string;
    credits?: number;
    /** Caller-supplied id (e.g. so derived values can key off it pre-insert). */
    id?: string;
  }): Promise<PlayerRow>;
  findPlayerByCallsign(callsign: string): Promise<PlayerRow | undefined>;
  getOrCreateStarterShip(
    playerId: string,
    opts?: {
      classId?: (typeof SHIP_CLASS_IDS)[number];
      position?: ShipPosition;
      /** Class caps to spawn at; defaults to the 100/100 schema defaults. */
      hull?: number;
      shields?: number;
    },
  ): Promise<ShipRow>;
  getShip(shipId: string): Promise<ShipRow | undefined>;
  getShipByOwner(playerId: string): Promise<ShipRow | undefined>;
  /** Insert a ship (used by dock purchases, TASK-20); caller sets class-full hull/shields. */
  createShip(input: {
    ownerId: string;
    classId: string;
    hull: number;
    shields: number;
    position: ShipPosition;
    state: ShipState;
    livery?: Livery;
  }): Promise<ShipRow>;
  /** Delete a ship and scrub its cargo (the v1 "sell to dock" rule). */
  deleteShipWithCargo(shipId: string): Promise<void>;
  saveShipState(shipId: string, state: ShipStateInput): Promise<ShipRow>;
  saveCargo(shipId: string, resourceType: string, quantity: number): Promise<CargoRow>;
  /**
   * Ships whose persisted position lives in `systemId`. Relies on the
   * repository invariant that position JSON is always written with
   * `systemId` as the first key (every write goes through this layer).
   */
  listShipsInSystem(systemId: string): Promise<ShipRow[]>;
  listCargo(shipIds: string[]): Promise<CargoRow[]>;
  getPlayersByIds(ids: string[]): Promise<PlayerRow[]>;
  getBalance(playerId: string): Promise<number>;
  addCredits(playerId: string, amount: number): Promise<PlayerRow>;
  withdrawCredits(playerId: string, amount: number): Promise<PlayerRow>;
  /**
   * Run a multi-write operation atomically: the callback receives the
   * repository bound to the transaction (same instance — all statements run
   * on the same connection); any throw rolls every write back.
   */
  withTransaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T>;
  upsertNodeState(
    nodeId: string,
    quantityRemaining: number,
    respawnAt?: string | null,
  ): Promise<NodeStateRow>;
  /**
   * Node states for a system. Pass `nodeIds` (derived from the seed) for an
   * exact IN query, or omit it to filter by node_id prefix — callers that
   * embed the system id in node ids (e.g. `${systemId}:${hash}`).
   */
  listNodeStates(systemId: string, nodeIds?: string[]): Promise<NodeStateRow[]>;
  upsertSystem(systemId: string, name: string, shardActive?: boolean): Promise<SystemRow>;
  findSystem(systemId: string): Promise<SystemRow | undefined>;
  createSession(input: SessionInput): Promise<SessionRow>;
  findSession(tokenHash: string): Promise<SessionRow | undefined>;
  setSessionSystem(tokenHash: string, systemId: string | null): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Delete sessions whose expires_at is before `nowIso`; returns the count. */
  deleteExpiredSessions(nowIso: string): Promise<number>;
}

/**
 * drizzle exposes the same query-builder surface for both dialects but has
 * no shared generic type; narrow once here and restore strict row types at
 * every return boundary.
 */
type Dialect = {
  insert: any;
  select: any;
  update: any;
  delete: any;
  run: any;
};

export function createRepo(db: Db, tables: Schema): Repository {
  const d = db as unknown as Dialect;
  const t = tables as unknown as Schema;

  async function findOne<T>(rows: unknown[]): Promise<T | undefined> {
    return (rows[0] as T | undefined) ?? undefined;
  }

  async function balanceOf(playerId: string): Promise<number> {
    const rows = await d
      .select({ credits: t.players.credits })
      .from(t.players)
      .where(eq(t.players.id, playerId))
      .limit(1);
    const row = rows[0] as { credits: number } | undefined;
    if (!row) throw new NotFoundError('player', playerId);
    return row.credits;
  }

  async function addCredits(playerId: string, amount: number): Promise<PlayerRow> {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`invalid credit amount: ${amount}`);
    }
    await d
      .update(t.players)
      .set({ credits: sql`${t.players.credits} + ${amount}` })
      .where(eq(t.players.id, playerId));
    const rows = await d.select().from(t.players).where(eq(t.players.id, playerId)).limit(1);
    const row = await findOne<PlayerRow>(rows);
    if (!row) throw new NotFoundError('player', playerId);
    return row;
  }

  async function withdrawCredits(playerId: string, amount: number): Promise<PlayerRow> {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`invalid credit amount: ${amount}`);
    }
    const before = (
      await d.select().from(t.players).where(eq(t.players.id, playerId)).limit(1)
    )[0] as PlayerRow | undefined;
    if (!before) throw new NotFoundError('player', playerId);
    // Atomic conditional update: the floor lives in the WHERE clause, so
    // concurrent withdrawals can never drive the balance negative.
    type RunResult = { changes?: number; rowCount?: number };
    const result = (await d
      .update(t.players)
      .set({ credits: sql`${t.players.credits} - ${amount}` })
      .where(and(eq(t.players.id, playerId), sql`${t.players.credits} >= ${amount}`))) as
      RunResult | RunResult[];
    const first = Array.isArray(result) ? result[0] : result;
    const changed = Number(first?.changes ?? first?.rowCount ?? 0);
    if (changed === 0) {
      throw new InsufficientCreditsError(playerId, amount, await balanceOf(playerId));
    }
    const rows = await d.select().from(t.players).where(eq(t.players.id, playerId)).limit(1);
    return (await findOne<PlayerRow>(rows))!;
  }

  const repo: Repository = {
    async createPlayer(input) {
      const player: Omit<PlayerRow, 'id'> = {
        callsign: input.callsign,
        credits: input.credits ?? 500,
        homeSystemId: input.homeSystemId,
        createdAt: nowIso(),
      };
      try {
        const inserted = await d
          .insert(t.players)
          .values({ ...player, id: input.id ?? uuid() })
          .returning();
        return inserted[0] as PlayerRow;
      } catch (err) {
        if (isUniqueViolation(err)) throw new CallsignTakenError(input.callsign);
        throw err;
      }
    },

    async findPlayerByCallsign(callsign) {
      const rows = await d
        .select()
        .from(t.players)
        .where(eq(t.players.callsign, callsign))
        .limit(1);
      return findOne<PlayerRow>(rows);
    },

    async getOrCreateStarterShip(playerId, opts) {
      const existing = await d.select().from(t.ships).where(eq(t.ships.ownerId, playerId)).limit(1);
      if (existing.length > 0) return existing[0] as ShipRow;
      const inserted = await d
        .insert(t.ships)
        .values({
          id: uuid(),
          ownerId: playerId,
          classId: opts?.classId ?? 'scout',
          livery: defaultLiveryFor(opts?.classId ?? 'scout'),
          hull: opts?.hull ?? 100,
          shields: opts?.shields ?? 100,
          position:
            opts?.position ?? ({ systemId: 'home', x: 0, y: 0, z: 0 } satisfies ShipPosition),
          velocity: { x: 0, y: 0, z: 0 } satisfies Vec3,
          state: 'docked' satisfies ShipState,
          updatedAt: nowIso(),
        })
        .returning();
      return inserted[0] as ShipRow;
    },

    async getShip(shipId) {
      const rows = await d.select().from(t.ships).where(eq(t.ships.id, shipId)).limit(1);
      return rows[0] as ShipRow | undefined;
    },

    async getShipByOwner(playerId) {
      const rows = await d.select().from(t.ships).where(eq(t.ships.ownerId, playerId)).limit(1);
      return rows[0] as ShipRow | undefined;
    },

    async createShip(input) {
      ShipPositionSchema.parse(input.position);
      if (!SHIP_STATES.includes(input.state)) {
        throw new Error(`invalid ship state: ${input.state}`);
      }
      const inserted = await d
        .insert(t.ships)
        .values({
          id: uuid(),
          ownerId: input.ownerId,
          classId: input.classId,
          livery: input.livery ?? defaultLiveryFor(input.classId),
          hull: input.hull,
          shields: input.shields,
          position: input.position,
          velocity: { x: 0, y: 0, z: 0 } satisfies Vec3,
          state: input.state,
          updatedAt: nowIso(),
        })
        .returning();
      return inserted[0] as ShipRow;
    },

    async deleteShipWithCargo(shipId) {
      await d.delete(t.cargoItems).where(eq(t.cargoItems.shipId, shipId));
      await d.delete(t.ships).where(eq(t.ships.id, shipId));
    },

    async saveShipState(shipId, state) {
      ShipPositionSchema.parse(state.position);
      Vec3Schema.parse(state.velocity);
      if (!SHIP_STATES.includes(state.state)) throw new Error(`invalid ship state: ${state.state}`);
      const livery = state.livery ? LiverySchema.parse(state.livery) : undefined;
      await d
        .update(t.ships)
        .set({
          hull: state.hull,
          shields: state.shields,
          position: state.position,
          velocity: state.velocity,
          state: state.state,
          ...(livery ? { livery } : {}),
          updatedAt: nowIso(),
        })
        .where(eq(t.ships.id, shipId));
      const rows = await d.select().from(t.ships).where(eq(t.ships.id, shipId)).limit(1);
      const row = await findOne<ShipRow>(rows);
      if (!row) throw new NotFoundError('ship', shipId);
      return row;
    },

    async saveCargo(shipId, resourceType, quantity) {
      if (!Number.isInteger(quantity) || quantity < 0) {
        throw new Error(`invalid cargo quantity: ${quantity}`);
      }
      const ship = await d.select().from(t.ships).where(eq(t.ships.id, shipId)).limit(1);
      if (ship.length === 0) throw new NotFoundError('ship', shipId);
      const upserted = await d
        .insert(t.cargoItems)
        .values({ id: uuid(), shipId, resourceType, quantity })
        .onConflictDoUpdate({
          target: [t.cargoItems.shipId, t.cargoItems.resourceType],
          set: { quantity },
        })
        .returning();
      return upserted[0] as CargoRow;
    },

    async listShipsInSystem(systemId) {
      // system ids are 16-hex by construction; reject anything that could
      // escape the LIKE pattern
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(systemId)) {
        throw new Error(`invalid systemId: ${systemId}`);
      }
      const rows = await d
        .select()
        .from(t.ships)
        .where(like(t.ships.position, `%"systemId":"${systemId}"%`));
      return rows as ShipRow[];
    },

    async listCargo(shipIds) {
      if (shipIds.length === 0) return [];
      const rows = await d.select().from(t.cargoItems).where(inArray(t.cargoItems.shipId, shipIds));
      return rows as CargoRow[];
    },

    async getPlayersByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await d.select().from(t.players).where(inArray(t.players.id, ids));
      return rows as PlayerRow[];
    },

    getBalance: balanceOf,
    addCredits,
    withdrawCredits,

    async withTransaction<T>(fn: (repo: Repository) => Promise<T>) {
      // Explicit BEGIN/COMMIT/ROLLBACK on the connection: better-sqlite3's
      // transaction() rejects async callbacks, and the explicit pair works
      // identically on both dialects. The callback gets this same instance
      // (one connection under both drivers), so every write lands inside
      // the transaction; any throw rolls them all back.
      await d.run(sql`BEGIN`);
      try {
        const value = await fn(repo);
        await d.run(sql`COMMIT`);
        return value;
      } catch (err) {
        await d.run(sql`ROLLBACK`);
        throw err;
      }
    },

    async upsertNodeState(nodeId, quantityRemaining, respawnAt = null) {
      if (!Number.isInteger(quantityRemaining) || quantityRemaining < 0) {
        throw new Error(`invalid node quantity: ${quantityRemaining}`);
      }
      const upserted = await d
        .insert(t.resourceNodeState)
        .values({ nodeId, quantityRemaining, respawnAt })
        .onConflictDoUpdate({
          target: t.resourceNodeState.nodeId,
          set: { quantityRemaining, respawnAt },
        })
        .returning();
      return upserted[0] as NodeStateRow;
    },

    async listNodeStates(systemId, nodeIds) {
      const where =
        nodeIds && nodeIds.length > 0
          ? inArray(t.resourceNodeState.nodeId, nodeIds)
          : like(t.resourceNodeState.nodeId, `${systemId}%`);
      const rows = await d.select().from(t.resourceNodeState).where(where);
      return rows as NodeStateRow[];
    },

    async upsertSystem(systemId, name, shardActive = false) {
      const upserted = await d
        .insert(t.systemRegistry)
        .values({ systemId, name, shardActive, lastActiveAt: nowIso() })
        .onConflictDoUpdate({
          target: t.systemRegistry.systemId,
          set: { name, shardActive, lastActiveAt: nowIso() },
        })
        .returning();
      return upserted[0] as SystemRow;
    },

    async findSystem(systemId) {
      const rows = await d
        .select()
        .from(t.systemRegistry)
        .where(eq(t.systemRegistry.systemId, systemId));
      return rows[0] as SystemRow | undefined;
    },

    async createSession(input) {
      const inserted = await d
        .insert(t.sessions)
        .values({
          tokenHash: input.tokenHash,
          playerId: input.playerId,
          systemId: input.systemId ?? null,
          createdAt: nowIso(),
          expiresAt: input.expiresAt,
        })
        .returning();
      return inserted[0] as SessionRow;
    },

    async findSession(tokenHash) {
      const rows = await d
        .select()
        .from(t.sessions)
        .where(eq(t.sessions.tokenHash, tokenHash))
        .limit(1);
      return findOne<SessionRow>(rows);
    },

    async setSessionSystem(tokenHash, systemId) {
      await d.update(t.sessions).set({ systemId }).where(eq(t.sessions.tokenHash, tokenHash));
    },

    async deleteSession(tokenHash) {
      await d.delete(t.sessions).where(eq(t.sessions.tokenHash, tokenHash));
    },

    async deleteExpiredSessions(now) {
      const expired = await d.select().from(t.sessions).where(lt(t.sessions.expiresAt, now));
      if (expired.length === 0) return 0;
      await d.delete(t.sessions).where(lt(t.sessions.expiresAt, now));
      return expired.length;
    },
  };

  return repo;
}

export type { Livery, ShipPosition, Vec3 };
