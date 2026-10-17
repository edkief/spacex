/**
 * SQLite repository — world-domain methods (credits + nodes + sessions +
 * registry).
 *
 * Implementation methods for operations that operate on cross-player
 * state. The identity methods (players, ships, cargo) live in
 * `./repo.sqlite.identity.ts`. The top-level factory
 * (`repo.sqlite.ts`) composes the two.
 *
 * The credit helpers live in `./repo.sqlite.world.credits.ts` so this
 * file stays focused on the non-credit world surface (nodes,
 * sessions, registry) and on the `runInTransaction` plumbing.
 */
import { eq, and } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sqliteSchema } from "./schema.sqlite.js";
import type {
  CreateSessionInput,
  PlayerRow,
  ResourceNodeStateRow,
  SessionRow,
  SystemRegistryRow,
  UpsertNodeStateInput,
} from "./types.js";
import { NotFoundError } from "./errors.js";
import { isoNow } from "./repo.helpers.js";
import { mapNodeState, mapSession, mapSystemRegistry } from "./repo.sqlite.mappers.js";
import type { CreateSystemRegistryInput } from "./repo.js";
import {
  sqliteAddSync,
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
  /**
   * Run a synchronous callback inside a single `BEGIN ... COMMIT`. If
   * the callback throws, every write the callback issued is rolled
   * back — that is the property TASK-41 AC #6 ("transaction rollback
   * on mid-failure") relies on. The callback is sync by design:
   * better-sqlite3 is sync, so all repo operations inside the open
   * transaction complete before the callback returns.
   */
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
        };
        return fn(tx);
      });
      // Drizzle's `transaction()` is synchronous; the Promise wrapper
      // keeps the surface uniform with the other async repo methods.
      return Promise.resolve(result);
    },
  };
}
