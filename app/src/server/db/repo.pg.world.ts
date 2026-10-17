/**
 * Postgres repository — world-domain methods (credits + nodes + sessions +
 * registry).
 *
 * Implementation methods for operations that operate on cross-player
 * state. The identity methods (players, ships, cargo) live in
 * `./repo.pg.identity.ts`. The top-level factory (`repo.pg.ts`)
 * composes the two.
 */
import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgSchema } from "./schema.pg.js";
import type {
  CreateSessionInput,
  PlayerRow,
  ResourceNodeStateRow,
  SessionRow,
  SystemRegistryRow,
  UpsertNodeStateInput,
} from "./types.js";
import { InsufficientCreditsError, NotFoundError } from "./errors.js";
import { assertPositiveInt } from "./repo.helpers.js";
import { mapNodeState, mapPlayer, mapSession, mapSystemRegistry } from "./repo.pg.mappers.js";
import type { CreateSystemRegistryInput } from "./repo.js";

/**
 * Cross-player lookup callback used by world methods. Filled in by the
 * factory once the identity methods are also bound — breaks the cyclic
 * dependency between the two.
 */
export interface PgIdentityCallbacks {
  findPlayerById(id: string): Promise<PlayerRow | null>;
}

/**
 * Bind world-domain query methods to the given Postgres database.
 *
 * `identity` exposes the player-lookup methods the world implementation
 * needs (`addCredits`, `withdrawCredits`, etc.). The factory wires the
 * two callbacks together so each side stays independently testable.
 *
 * The credit UPDATE statements use SQL-level atomic expressions
 * (`credits = credits + ?` / `credits = credits - ? WHERE credits >= ?`)
 * to match the SQLite implementation's compare-and-swap semantics.
 */
export function bindPgWorld(
  db: NodePgDatabase<typeof pgSchema>,
  identity: PgIdentityCallbacks,
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
} {
  return {
    async addCredits(playerId: string, amount: number): Promise<PlayerRow> {
      assertPositiveInt(amount, "addCredits");
      const rows = await db
        .update(pgSchema.players)
        .set({ credits: sql`${pgSchema.players.credits} + ${amount}` })
        .where(eq(pgSchema.players.id, playerId))
        .returning();
      if (rows.length === 0) {
        throw new NotFoundError("Player", playerId);
      }
      const first = rows[0];
      if (!first) throw new Error("update returned no rows");
      return mapPlayer(first);
    },

    async withdrawCredits(playerId: string, amount: number): Promise<PlayerRow> {
      assertPositiveInt(amount, "withdrawCredits");
      // Compare-and-swap debit, atomic at the SQL level. Postgres
      // serializes concurrent UPDATE statements via row-level locks,
      // so the `credits >= ?` guard prevents over-withdraw when two
      // callers race for the last funds.
      const rows = await db
        .update(pgSchema.players)
        .set({ credits: sql`${pgSchema.players.credits} - ${amount}` })
        .where(
          and(eq(pgSchema.players.id, playerId), sql`${pgSchema.players.credits} >= ${amount}`),
        )
        .returning();
      if (rows.length === 0) {
        // Either the player doesn't exist or they don't have the funds.
        const existing = await identity.findPlayerById(playerId);
        if (!existing) throw new NotFoundError("Player", playerId);
        throw new InsufficientCreditsError(playerId, existing.credits, amount);
      }
      const first = rows[0];
      if (!first) throw new Error("update returned no rows");
      return mapPlayer(first);
    },

    async getBalance(playerId: string): Promise<number> {
      const row = await identity.findPlayerById(playerId);
      if (!row) throw new NotFoundError("Player", playerId);
      return row.credits;
    },

    async upsertNodeState(input: UpsertNodeStateInput): Promise<ResourceNodeStateRow> {
      const rows = await db
        .insert(pgSchema.resourceNodeState)
        .values({
          nodeId: input.nodeId,
          quantityRemaining: input.quantityRemaining,
          respawnAt: input.respawnAt,
          systemId: input.systemId,
        })
        .onConflictDoUpdate({
          target: pgSchema.resourceNodeState.nodeId,
          set: {
            quantityRemaining: input.quantityRemaining,
            respawnAt: input.respawnAt,
            systemId: input.systemId,
          },
        })
        .returning();
      const first = rows[0];
      if (!first) throw new Error("upsert returned no rows");
      return mapNodeState(first);
    },

    async listNodeStates(systemId: string): Promise<ResourceNodeStateRow[]> {
      const rows = await db
        .select()
        .from(pgSchema.resourceNodeState)
        .where(and(eq(pgSchema.resourceNodeState.systemId, systemId)));
      return rows.map(mapNodeState);
    },

    async createSession(input: CreateSessionInput): Promise<SessionRow> {
      const expiresAt = new Date(Date.now() + input.ttlMs);
      const rows = await db
        .insert(pgSchema.sessions)
        .values({
          tokenHash: input.tokenHash,
          playerId: input.playerId,
          systemId: input.systemId ?? null,
          expiresAt,
        })
        .returning();
      const first = rows[0];
      if (!first) throw new Error("insert returned no rows");
      return mapSession(first);
    },

    async getSession(tokenHash: string): Promise<SessionRow | null> {
      const rows = await db
        .select()
        .from(pgSchema.sessions)
        .where(eq(pgSchema.sessions.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ? mapSession(rows[0]) : null;
    },

    async deleteSession(tokenHash: string): Promise<void> {
      await db.delete(pgSchema.sessions).where(eq(pgSchema.sessions.tokenHash, tokenHash));
    },

    async deleteSessionsByPlayerId(playerId: string): Promise<number> {
      const rows = await db
        .delete(pgSchema.sessions)
        .where(eq(pgSchema.sessions.playerId, playerId))
        .returning({ tokenHash: pgSchema.sessions.tokenHash });
      return rows.length;
    },

    async upsertSystemRegistry(row: CreateSystemRegistryInput): Promise<SystemRegistryRow> {
      const lastActiveAt = new Date();
      const rows = await db
        .insert(pgSchema.systemRegistry)
        .values({
          systemId: row.systemId,
          name: row.name,
          shardActive: row.shardActive,
          lastActiveAt,
        })
        .onConflictDoUpdate({
          target: pgSchema.systemRegistry.systemId,
          set: {
            name: row.name,
            shardActive: row.shardActive,
            lastActiveAt,
          },
        })
        .returning();
      const first = rows[0];
      if (!first) throw new Error("upsert returned no rows");
      return mapSystemRegistry(first);
    },

    async listActiveShards(): Promise<SystemRegistryRow[]> {
      const rows = await db
        .select()
        .from(pgSchema.systemRegistry)
        .where(eq(pgSchema.systemRegistry.shardActive, true));
      return rows.map(mapSystemRegistry);
    },
  };
}
