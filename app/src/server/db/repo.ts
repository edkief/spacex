import { and, eq, gte, inArray, like, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { SHIP_CLASSES } from '@shared/ships';
import { parseInventoryJson } from '@shared/inventory';
import type { Db } from './client';
import {
  CallsignTakenError,
  InsufficientCreditsError,
  NotFoundError,
  isUniqueViolation,
} from './errors';
import {
  SHIP_CLASS_IDS,
  SHIP_REGIMES,
  SHIP_STATES,
  type CargoRow,
  type Livery,
  type DepositRow,
  type NodeStateRow,
  type PlayerRow,
  type Quat,
  type Schema,
  type SessionRow,
  type ShipPosition,
  type ShipRegime,
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
export const QuatSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  w: z.number().finite(),
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
  /** TASK-24: sim orientation; only written when provided. */
  rotation?: Quat;
  /** TASK-24: sim kinematic regime; only written when provided. */
  regime?: ShipRegime;
  /** TASK-24: pad id or null (settled on a pad); only written when provided. */
  onPad?: string | null;
  /** TASK-24: destruction timestamp or null; only written when provided. */
  destroyedAt?: string | null;
  /**
   * TASK-39: the cargo hold's raw stacks JSON ('{"iron":10}' / '{}' when
   * empty); undefined = keep the stored value (the upsert COALESCEs it).
   */
  cargo?: string | null;
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
  /**
   * TASK-34: read the player's inventory as Parsed stacks ({} when empty or
   * corrupt — the raw JSON is validated here, one definition for the read
   * sites).
   */
  getPlayerInventory(playerId: string): Promise<Record<string, number>>;
  /** TASK-34: persist the player's inventory stacks (shard flush cadence). */
  updatePlayerInventory(playerId: string, stacks: Record<string, number>): Promise<void>;
  /**
   * TASK-40: persist the ship's cargo-hold stacks (ships.cargo JSON) in ONE
   * UPDATE — the sell path writes it inside the same transaction as its
   * addCredits (atomicity: a failed credit write rolls the stack back).
   */
  updateShipCargo(shipId: string, stacks: Record<string, number>): Promise<void>;
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
  /** TASK-24: delete ship rows (expired wreck cleanup); returns rows deleted. */
  deleteShips(shipIds: string[]): Promise<number>;
  /**
   * TASK-24: upsert ship states BY OWNER in ONE statement (the shard flush
   * hot path). Multi-row INSERT ... ON CONFLICT (owner_id) DO UPDATE: a
   * missing row (v1 invariant: one ship per player, uq_ships_owner) is
   * inserted with the class default livery; existing rows get the full
   * state. The whole flush is thus a single small transaction.
   */
  upsertShipStates(
    rows: Array<{ ownerId: string; classId: string; state: ShipStateInput }>,
  ): Promise<number>;
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
  /**
   * TASK-37: upsert a deposit's delta row (created lazily on first mine;
   * conflict on the (system_id, deposit_seq) key).
   */
  upsertDeposit(input: DepositRow): Promise<DepositRow>;
  /** TASK-37: the system's persisted deposit deltas (empty before first mine). */
  listDeposits(systemId: string): Promise<DepositRow[]>;
  /**
   * TASK-37: ATOMIC decrement of a deposit's remaining amount (single
   * UPDATE, guarded by remaining >= amount — a concurrent over-mine can
   * never drive the row below 0). Returns the updated row, or undefined
   * when the row is missing (not yet mined) or already depleted.
   */
  decrementDeposit(
    systemId: string,
    depositSeq: number,
    amount: number,
  ): Promise<DepositRow | undefined>;
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
      const player: Omit<PlayerRow, 'id' | 'inventory'> = {
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

    async getPlayerInventory(playerId) {
      const rows = await d
        .select({ inventory: t.players.inventory })
        .from(t.players)
        .where(eq(t.players.id, playerId))
        .limit(1);
      // parseInventoryJson handles empty/corrupt rows (→ {} — the shard
      // sanitizes the same way when it loads directly from a row).
      return parseInventoryJson(rows[0]?.inventory);
    },

    async updatePlayerInventory(playerId, stacks) {
      await d
        .update(t.players)
        .set({ inventory: JSON.stringify(stacks) })
        .where(eq(t.players.id, playerId));
    },

    async updateShipCargo(shipId, stacks) {
      await d
        .update(t.ships)
        .set({ cargo: JSON.stringify(stacks), updatedAt: nowIso() })
        .where(eq(t.ships.id, shipId));
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
      const rotation = state.rotation ? QuatSchema.parse(state.rotation) : undefined;
      let regime: ShipRegime | undefined;
      if (state.regime !== undefined) {
        if (!(SHIP_REGIMES as readonly string[]).includes(state.regime)) {
          throw new Error(`invalid ship regime: ${state.regime}`);
        }
        regime = state.regime;
      }
      await d
        .update(t.ships)
        .set({
          hull: state.hull,
          shields: state.shields,
          position: state.position,
          velocity: state.velocity,
          state: state.state,
          ...(livery ? { livery } : {}),
          ...(rotation ? { rotation } : {}),
          ...(regime ? { regime } : {}),
          ...(state.onPad !== undefined ? { onPad: state.onPad } : {}),
          ...(state.destroyedAt !== undefined ? { destroyedAt: state.destroyedAt } : {}),
          ...(state.cargo !== undefined ? { cargo: state.cargo } : {}),
          updatedAt: nowIso(),
        })
        .where(eq(t.ships.id, shipId));
      const rows = await d.select().from(t.ships).where(eq(t.ships.id, shipId)).limit(1);
      const row = await findOne<ShipRow>(rows);
      if (!row) throw new NotFoundError('ship', shipId);
      return row;
    },

    async deleteShips(shipIds: string[]): Promise<number> {
      if (shipIds.length === 0) return 0;
      type RunResult = { changes?: number; rowCount?: number };
      const result = (await d.delete(t.ships).where(inArray(t.ships.id, shipIds))) as
        RunResult | RunResult[];
      const first = Array.isArray(result) ? result[0] : result;
      return Number(first?.changes ?? first?.rowCount ?? 0);
    },

    async upsertShipStates(rows) {
      if (rows.length === 0) return 0;
      // Hot path (shard flush): values come from the in-process sim, not a
      // client. Keep the corrupt-row guards (finite vecs, known state — the
      // flush must never persist NaN) but skip the full zod codec passes of
      // saveShipState so the 30 s cadence stays under one 50 ms tick.
      for (const { state } of rows) {
        const p = state.position;
        const v = state.velocity;
        const finite = [p.x, p.y, p.z, v.x, v.y, v.z].every(
          (n) => typeof n === 'number' && Number.isFinite(n),
        );
        if (!finite || typeof p.systemId !== 'string' || p.systemId.length === 0) {
          throw new Error('non-finite or invalid ship position/velocity');
        }
        if (!SHIP_STATES.includes(state.state)) {
          throw new Error(`invalid ship state: ${state.state}`);
        }
      }
      const nowIso = new Date().toISOString();
      const values = rows.map((r) => ({
        id: uuid(),
        ownerId: r.ownerId,
        classId: r.classId,
        livery: r.state.livery ?? defaultLiveryFor(r.classId),
        hull: r.state.hull,
        shields: r.state.shields,
        position: r.state.position,
        velocity: r.state.velocity,
        state: r.state.state,
        rotation: r.state.rotation ?? ({ x: 0, y: 0, z: 0, w: 1 } satisfies Quat),
        regime: r.state.regime ?? 'space',
        onPad: r.state.onPad ?? null,
        destroyedAt: r.state.destroyedAt ?? null,
        // undefined cargo → NULL (the conflict set COALESCEs back to the
        // stored value, so an entity without a cargo in memory never wipes it).
        cargo: r.state.cargo ?? null,
        updatedAt: nowIso,
      }));
      // ONE statement for the whole batch: each row upserts on its owner key
      // (excluded.* keeps per-row values on conflict).
      await d
        .insert(t.ships)
        .values(values)
        .onConflictDoUpdate({
          target: t.ships.ownerId,
          set: {
            hull: sql`excluded.hull`,
            shields: sql`excluded.shields`,
            position: sql`excluded.position`,
            velocity: sql`excluded.velocity`,
            state: sql`excluded.state`,
            livery: sql`excluded.livery`,
            rotation: sql`excluded.rotation`,
            regime: sql`excluded.regime`,
            onPad: sql`excluded.on_pad`,
            destroyedAt: sql`excluded.destroyed_at`,
            // TASK-39: a NULL excluded.cargo (entity had none) KEEPS the
            // stored value — only a real write clobbers it.
            cargo: sql`COALESCE(excluded.cargo, ${t.ships.cargo})`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
      return rows.length;
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

    async upsertDeposit(input) {
      if (!Number.isInteger(input.remaining) || input.remaining < 0) {
        throw new Error(`invalid deposit remaining: ${input.remaining}`);
      }
      const upserted = await d
        .insert(t.deposits)
        .values(input)
        .onConflictDoUpdate({
          target: [t.deposits.systemId, t.deposits.depositSeq],
          set: {
            depositId: input.depositId,
            planetId: input.planetId,
            pos: input.pos,
            resourceId: input.resourceId,
            remaining: input.remaining,
            discovered: input.discovered,
          },
        })
        .returning();
      return upserted[0] as DepositRow;
    },

    async listDeposits(systemId) {
      const rows = await d.select().from(t.deposits).where(eq(t.deposits.systemId, systemId));
      return rows as DepositRow[];
    },

    async decrementDeposit(systemId, depositSeq, amount) {
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error(`invalid deposit amount: ${amount}`);
      }
      const rows = await d
        .update(t.deposits)
        .set({
          remaining: sql`${t.deposits.remaining} - ${amount}`,
          discovered: true,
        })
        .where(
          and(
            eq(t.deposits.systemId, systemId),
            eq(t.deposits.depositSeq, depositSeq),
            gte(t.deposits.remaining, amount),
          ),
        )
        .returning();
      return (rows[0] as DepositRow | undefined) ?? undefined;
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
