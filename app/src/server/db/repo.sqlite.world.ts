/**
 * SQLite repository — world-domain methods (credits + nodes + sessions +
 * registry + ship purchase).
 *
 * Implementation methods for operations that operate on cross-player
 * state. The identity methods (players, ships, cargo) live in
 * `./repo.sqlite.identity.ts`. The top-level factory
 * (`repo.sqlite.ts`) composes the two.
 *
 * The credit helpers live in `./repo.sqlite.world.credits.ts` so this
 * file stays focused on the non-credit world surface (nodes,
 * sessions, registry) and on the transaction plumbing used by
 * `purchaseShip`.
 */
import { eq, and } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sqliteSchema } from "./schema.sqlite.js";
import type {
  CreateSessionInput,
  PlayerRow,
  ResourceNodeStateRow,
  SessionRow,
  ShipClassId,
  ShipLivery,
  ShipRow,
  SystemRegistryRow,
  UpsertNodeStateInput,
} from "./types.js";
import { InsufficientCreditsError, NotFoundError } from "./errors.js";
import { isoNow } from "./repo.helpers.js";
import { mapNodeState, mapSession, mapShip, mapSystemRegistry } from "./repo.sqlite.mappers.js";
import {
  AlreadyOwnedShipError,
  DEFAULT_LIVERY,
  NotDockedError,
  STARTER_HULL,
  STARTER_SHIELDS,
  type CreateSystemRegistryInput,
} from "./repo.js";
import {
  sqliteAddSync,
  sqliteReplaceShip,
  sqliteWithdrawSync,
  type SqliteCreditHandle,
} from "./repo.sqlite.world.credits.js";

/**
 * Cross-player lookup callback used by world methods. Filled in by the
 * factory once the identity methods are also bound — breaks the cyclic
 * dependency between the two.
 */
export interface SqliteIdentityCallbacks {
  findPlayerById(id: string): Promise<PlayerRow | null>;
}

/**
 * Bind world-domain query methods to the given SQLite database.
 *
 * `identity` exposes the player-lookup methods the world implementation
 * needs (`addCredits`, `withdrawCredits`, etc.). The factory wires the
 * two callbacks together so each side stays independently testable.
 *
 * Credit-balance reads/writes use SQL-level atomic UPDATE statements
 * (`SET credits = credits ± ? WHERE id = ? AND credits >= ?`) so that
 * 100+ concurrent withdrawals of the same balance cannot race past
 * zero — better-sqlite3 serializes writes at the driver layer, and
 * the WHERE clause is the canonical "compare-and-swap" guard. This
 * is what makes the TASK-41 AC ("100 concurrent withdrawals of 10
 * against 500 → 50 success, balance 0") hold.
 */
export function bindSqliteWorld(
  db: BetterSQLite3Database<typeof sqliteSchema>,
  identity: SqliteIdentityCallbacks,
): {
  addCredits: (playerId: string, amount: number) => Promise<PlayerRow>;
  withdrawCredits: (playerId: string, amount: number) => Promise<PlayerRow>;
  getBalance: (playerId: string) => Promise<number>;
  upsertNodeState: (input: UpsertNodeStateInput) => Promise<ResourceNodeStateRow>;
  listNodeStates: (systemId: string) => Promise<ResourceNodeStateRow[]>;
  createSession: (input: CreateSessionInput) => Promise<SessionRow>;
  getSession: (tokenHash: string) => Promise<SessionRow | null>;
  deleteSession: (tokenHash: string) => Promise<void>;
  deleteSessionsByPlayerId: (playerId: string) => Promise<number>;
  upsertSystemRegistry: (row: CreateSystemRegistryInput) => Promise<SystemRegistryRow>;
  listActiveShards: () => Promise<SystemRegistryRow[]>;
  purchaseShip: (input: {
    playerId: string;
    classId: ShipClassId;
    price: number;
    hull: number;
    shields: number;
    livery: ShipLivery;
  }) => Promise<ShipRow>;
  repairShip: (input: {
    playerId: string;
    shipId: string;
    cost: number;
    maxHull: number;
    maxShields: number;
  }) => Promise<ShipRow>;
  runInTransaction: <T>(fn: (tx: SqliteCreditHandle) => T) => Promise<T>;
} {
  return {
    async addCredits(playerId: string, amount: number): Promise<PlayerRow> {
      sqliteAddSync(db, playerId, amount);
      const refreshed = await identity.findPlayerById(playerId);
      if (!refreshed) {
        throw new Error(`addCredits: row vanished after update id=${playerId}`);
      }
      return refreshed;
    },

    async withdrawCredits(playerId: string, amount: number): Promise<PlayerRow> {
      sqliteWithdrawSync(db, playerId, amount);
      const refreshed = await identity.findPlayerById(playerId);
      if (!refreshed) {
        throw new Error(`withdrawCredits: row vanished after update id=${playerId}`);
      }
      return refreshed;
    },

    async getBalance(playerId: string): Promise<number> {
      const row = await identity.findPlayerById(playerId);
      if (!row) throw new NotFoundError("Player", playerId);
      return row.credits;
    },

    async upsertNodeState(input: UpsertNodeStateInput): Promise<ResourceNodeStateRow> {
      const respawnAtIso = input.respawnAt ? input.respawnAt.toISOString() : null;
      await db
        .insert(sqliteSchema.resourceNodeState)
        .values({
          nodeId: input.nodeId,
          quantityRemaining: input.quantityRemaining,
          respawnAt: respawnAtIso,
          systemId: input.systemId,
        })
        .onConflictDoUpdate({
          target: sqliteSchema.resourceNodeState.nodeId,
          set: {
            quantityRemaining: input.quantityRemaining,
            respawnAt: respawnAtIso,
            systemId: input.systemId,
          },
        })
        .run();
      const rows = await db
        .select()
        .from(sqliteSchema.resourceNodeState)
        .where(eq(sqliteSchema.resourceNodeState.nodeId, input.nodeId))
        .limit(1);
      const first = rows[0];
      if (!first) {
        throw new Error(`upsertNodeState: row vanished after upsert id=${input.nodeId}`);
      }
      return mapNodeState(first);
    },

    async listNodeStates(systemId: string): Promise<ResourceNodeStateRow[]> {
      const rows = await db
        .select()
        .from(sqliteSchema.resourceNodeState)
        .where(and(eq(sqliteSchema.resourceNodeState.systemId, systemId)));
      return rows.map(mapNodeState);
    },

    async createSession(input: CreateSessionInput): Promise<SessionRow> {
      const expiresAt = new Date(Date.now() + input.ttlMs);
      await db
        .insert(sqliteSchema.sessions)
        .values({
          tokenHash: input.tokenHash,
          playerId: input.playerId,
          systemId: input.systemId ?? null,
          createdAt: isoNow(),
          expiresAt: expiresAt.toISOString(),
        })
        .run();
      const row = await this.getSession(input.tokenHash);
      if (!row) {
        throw new Error(
          `createSession: row vanished after insert hash=${input.tokenHash.slice(0, 8)}…`,
        );
      }
      return row;
    },

    async getSession(tokenHash: string): Promise<SessionRow | null> {
      const rows = await db
        .select()
        .from(sqliteSchema.sessions)
        .where(eq(sqliteSchema.sessions.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ? mapSession(rows[0]) : null;
    },

    async deleteSession(tokenHash: string): Promise<void> {
      await db
        .delete(sqliteSchema.sessions)
        .where(eq(sqliteSchema.sessions.tokenHash, tokenHash))
        .run();
    },

    async deleteSessionsByPlayerId(playerId: string): Promise<number> {
      // `run()` returns the count of affected rows on better-sqlite3.
      const result = await db
        .delete(sqliteSchema.sessions)
        .where(eq(sqliteSchema.sessions.playerId, playerId))
        .run();
      return result.changes ?? 0;
    },

    async upsertSystemRegistry(row: CreateSystemRegistryInput): Promise<SystemRegistryRow> {
      const lastActiveAt = isoNow();
      await db
        .insert(sqliteSchema.systemRegistry)
        .values({
          systemId: row.systemId,
          name: row.name,
          shardActive: row.shardActive,
          lastActiveAt,
        })
        .onConflictDoUpdate({
          target: sqliteSchema.systemRegistry.systemId,
          set: {
            name: row.name,
            shardActive: row.shardActive,
            lastActiveAt,
          },
        })
        .run();
      const rows = await db
        .select()
        .from(sqliteSchema.systemRegistry)
        .where(eq(sqliteSchema.systemRegistry.systemId, row.systemId))
        .limit(1);
      const first = rows[0];
      if (!first) {
        throw new Error(`upsertSystemRegistry: row vanished after upsert id=${row.systemId}`);
      }
      return mapSystemRegistry(first);
    },

    async listActiveShards(): Promise<SystemRegistryRow[]> {
      const rows = await db
        .select()
        .from(sqliteSchema.systemRegistry)
        .where(eq(sqliteSchema.systemRegistry.shardActive, true));
      return rows.map(mapSystemRegistry);
    },

    /**
     * TASK-20 ship purchase. Opens its own `BEGIN ... COMMIT`
     * transaction so the validation + credit + ship steps are
     * atomic. The mid-flight validation that requires DB state
     * reads (current ship row, docked state) happens inside the
     * callback; if any check fails the transaction rolls back and
     * the player keeps their old ship + cargo.
     *
     * The route layer (`@server/routes/ships.ts`) is responsible
     * for parsing the inbound body, looking up the catalog price,
     * and translating the typed errors into HTTP responses.
     */
    purchaseShip(input: {
      playerId: string;
      classId: ShipClassId;
      price: number;
      hull: number;
      shields: number;
      livery: ShipLivery;
    }): Promise<ShipRow> {
      // Wrap the synchronous drizzle transaction in a Promise so
      // thrown errors (NotFoundError, NotDockedError,
      // InsufficientCreditsError, AlreadyOwnedShipError) surface
      // as rejections rather than escaping the function call. The
      // inner `db.transaction(...)` rolls back on any throw.
      return new Promise<ShipRow>((resolve, reject) => {
        try {
          const result = db.transaction((txDb): ShipRow => {
            // 1. Verify the player currently owns a ship row.
            const ownedRows = txDb
              .select()
              .from(sqliteSchema.ships)
              .where(eq(sqliteSchema.ships.ownerId, input.playerId))
              .limit(1)
              .all();
            if (ownedRows.length === 0) {
              throw new NotFoundError("PlayerShip", input.playerId);
            }
            const existing = mapShip(ownedRows[0]!);

            // 2. Already owns this exact class? Route maps to 409.
            if (existing.classId === input.classId) {
              throw new AlreadyOwnedShipError(input.playerId, input.classId);
            }

            // 3. Must be docked to buy (mid-flight purchase would be
            //    physically nonsensical — see spec).
            if (existing.state !== "docked") {
              throw new NotDockedError(input.playerId);
            }

            // 4. Withdraw the price. Throws `InsufficientCreditsError`
            //    on insufficient funds; Drizzle rolls back if it
            //    propagates out of the callback.
            try {
              sqliteWithdrawSync(txDb, input.playerId, input.price);
            } catch (err) {
              if (err instanceof InsufficientCreditsError) throw err;
              throw err;
            }

            // 5. Replace the ship row + cascade the cargo.
            const newShip = sqliteReplaceShip(
              txDb,
              input.playerId,
              input.classId,
              input.hull,
              input.shields,
              input.livery,
            );
            return newShip;
          });
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    },

    /**
     * TASK-23 dock repair. Opens its own `BEGIN ... COMMIT` so the
     * docked-state validation + credit withdraw + hull/shield restore
     * is atomic. Mirrors `purchaseShip`'s shape: throw typed errors
     * (`NotDockedError`, `InsufficientCreditsError`,
     * `NotFoundError`) that the route maps to HTTP codes.
     *
     * The cost is computed by the route layer
     * (`@shared/physics/damage.repairCost`) so this module stays free
     * of any "what should repair cost?" policy. We just verify the
     * withdrawal succeeded and the row was updated.
     */
    async repairShip(input: {
      playerId: string;
      shipId: string;
      cost: number;
      maxHull: number;
      maxShields: number;
    }): Promise<ShipRow> {
      return new Promise<ShipRow>((resolve, reject) => {
        try {
          const result = db.transaction((txDb): ShipRow => {
            // 1. Load the ship row and verify it belongs to the player.
            const shipRows = txDb
              .select()
              .from(sqliteSchema.ships)
              .where(eq(sqliteSchema.ships.id, input.shipId))
              .limit(1)
              .all();
            if (shipRows.length === 0) {
              throw new NotFoundError("Ship", input.shipId);
            }
            const existing = mapShip(shipRows[0]!);
            if (existing.ownerId !== input.playerId) {
              throw new NotFoundError("Ship", input.shipId);
            }

            // 2. Must be docked to repair (mid-flight repair would be
            //    physically nonsensical; the dock is the only place
            //    with a repair rig).
            if (existing.state !== "docked") {
              throw new NotDockedError(input.playerId);
            }

            // 3. Withdraw the repair cost. Throws
            //    `InsufficientCreditsError` on insufficient funds;
            //    Drizzle rolls back via the outer transaction.
            //    Cost of 0 is a no-op (ship already fully repaired);
            //    skip the withdraw so `assertPositiveInt` doesn't reject
            //    the 0.
            if (input.cost > 0) {
              sqliteWithdrawSync(txDb, input.playerId, input.cost);
            }

            // 4. Restore hull + shields to class max.
            txDb
              .update(sqliteSchema.ships)
              .set({ hull: input.maxHull, shields: input.maxShields })
              .where(eq(sqliteSchema.ships.id, input.shipId))
              .run();

            // 5. Re-load the row so the caller sees the post-repair
            //    snapshot.
            const refreshedRows = txDb
              .select()
              .from(sqliteSchema.ships)
              .where(eq(sqliteSchema.ships.id, input.shipId))
              .limit(1)
              .all();
            const refreshedRow = refreshedRows[0];
            if (!refreshedRow) {
              throw new Error(`repairShip: row vanished after update id=${input.shipId}`);
            }
            return mapShip(refreshedRow);
          });
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    },

    async runInTransaction<T>(fn: (tx: SqliteCreditHandle) => T): Promise<T> {
      // Drizzle's `db.transaction()` wraps the callback in a real
      // SQLite transaction (BEGIN ... COMMIT). The callback receives a
      // transactional `tx` instance that participates in the open
      // transaction; every SQL statement we issue through `txDb` flows
      // through better-sqlite3's `IN TRANSACTION` state.
      //
      // On any throw inside the callback, Drizzle rolls back the
      // transaction automatically before re-throwing — that is the
      // property TASK-41 AC #6 ("transaction rollback on mid-failure")
      // relies on.
      const result = db.transaction((txDb: BetterSQLite3Database<typeof sqliteSchema>): T => {
        const tx: SqliteCreditHandle = {
          addCredits: (pid, amount) => sqliteAddSync(txDb, pid, amount),
          withdrawCredits: (pid, amount) => sqliteWithdrawSync(txDb, pid, amount),
          /**
           * The transaction handle's `replaceOwnedShip` is a
           * convenience for callers that already know the row data
           * — typically used by tests. Public callers go through
           * `purchaseShip` which opens its own BEGIN. Falls back to
           * `STARTER_HULL/SHIELDS + DEFAULT_LIVERY` so the
           * "replace with starter defaults" use case is simple.
           */
          replaceOwnedShip: (pid, classId) =>
            sqliteReplaceShip(txDb, pid, classId, STARTER_HULL, STARTER_SHIELDS, DEFAULT_LIVERY),
        };
        return fn(tx);
      });
      // Drizzle's `transaction()` is synchronous; the Promise wrapper
      // keeps the surface uniform with the other async repo methods.
      return Promise.resolve(result);
    },
  };
}
