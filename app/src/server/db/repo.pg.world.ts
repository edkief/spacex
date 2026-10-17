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
  ShipClassId,
  ShipLivery,
  ShipRow,
  SystemRegistryRow,
  UpsertNodeStateInput,
} from "./types.js";
import { InsufficientCreditsError, NotFoundError } from "./errors.js";
import { assertPositiveInt } from "./repo.helpers.js";
import {
  mapNodeState,
  mapPlayer,
  mapShip,
  mapSession,
  mapSystemRegistry,
} from "./repo.pg.mappers.js";
import { AlreadyOwnedShipError, NotDockedError, type CreateSystemRegistryInput } from "./repo.js";
import { ShipLiverySchema } from "./types.js";
import { randomUUID } from "node:crypto";

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

    async purchaseShip(input: {
      playerId: string;
      classId: ShipClassId;
      price: number;
      hull: number;
      shields: number;
      livery: ShipLivery;
    }): Promise<ShipRow> {
      // Postgres uses `db.transaction()` to wrap the SQL flow —
      // drizzle's pg driver issues `BEGIN` / `COMMIT` on the
      // connection, atomically committing the credit withdraw +
      // ship delete + ship insert. Any throw here rolls the whole
      // batch back; the player keeps their old ship + cargo.
      return db.transaction(async (txDb): Promise<ShipRow> => {
        // 1. Verify the player currently owns a ship row.
        const ownedRows = await txDb
          .select()
          .from(pgSchema.ships)
          .where(eq(pgSchema.ships.ownerId, input.playerId))
          .limit(1);
        if (ownedRows.length === 0) {
          throw new NotFoundError("PlayerShip", input.playerId);
        }
        const existing = mapShip(ownedRows[0]!);

        // 2. Already owns this exact class? Route maps to 409.
        if (existing.classId === input.classId) {
          throw new AlreadyOwnedShipError(input.playerId, input.classId);
        }

        // 3. Must be docked.
        if (existing.state !== "docked") {
          throw new NotDockedError(input.playerId);
        }

        // 4. Withdraw the price (compare-and-swap on credits).
        //    The credit helper throws `InsufficientCreditsError` on
        //    failure; PG rolls back via the outer transaction.
        const debited = await txDb
          .update(pgSchema.players)
          .set({ credits: sql`${pgSchema.players.credits} - ${input.price}` })
          .where(
            and(
              eq(pgSchema.players.id, input.playerId),
              sql`${pgSchema.players.credits} >= ${input.price}`,
            ),
          )
          .returning({ id: pgSchema.players.id });
        if (debited.length === 0) {
          const after = await identity.findPlayerById(input.playerId);
          throw new InsufficientCreditsError(input.playerId, after?.credits ?? 0, input.price);
        }

        // 5. Replace the ship (delete old + cascade cargo, then insert new).
        await txDb.delete(pgSchema.ships).where(eq(pgSchema.ships.ownerId, input.playerId));
        // Re-parse the livery through zod as a defence-in-depth step.
        const safeLivery = ShipLiverySchema.parse(input.livery);
        const inserted = await txDb
          .insert(pgSchema.ships)
          .values({
            id: randomUUID(),
            ownerId: input.playerId,
            classId: input.classId,
            livery: safeLivery,
            hull: input.hull,
            shields: input.shields,
            position: { systemId: "", x: 0, y: 0, z: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            state: "docked",
          })
          .returning();
        const first = inserted[0];
        if (!first) throw new Error("purchaseShip: insert returned no rows");
        return mapShip(first);
      });
    },

    /**
     * TASK-23 dock repair. Opens a `BEGIN ... COMMIT` transaction
     * so the docked-state validation + credit withdraw + hull/shield
     * restore are atomic. Same shape as the SQLite implementation
     * (`NotDockedError`, `InsufficientCreditsError`,
     * `NotFoundError`); the route maps these to HTTP codes.
     */
    async repairShip(input: {
      playerId: string;
      shipId: string;
      cost: number;
      maxHull: number;
      maxShields: number;
    }): Promise<ShipRow> {
      return db.transaction(async (txDb): Promise<ShipRow> => {
        // 1. Load the ship row and verify it belongs to the player.
        const shipRows = await txDb
          .select()
          .from(pgSchema.ships)
          .where(eq(pgSchema.ships.id, input.shipId))
          .limit(1);
        if (shipRows.length === 0) {
          throw new NotFoundError("Ship", input.shipId);
        }
        const existing = mapShip(shipRows[0]!);
        if (existing.ownerId !== input.playerId) {
          throw new NotFoundError("Ship", input.shipId);
        }

        // 2. Must be docked to repair.
        if (existing.state !== "docked") {
          throw new NotDockedError(input.playerId);
        }

        // 3. Withdraw the repair cost. Throws
        //    `InsufficientCreditsError` on insufficient funds.
        //    Cost of 0 is a no-op (ship already fully repaired); skip
        //    the withdraw so we don't issue an UPDATE with a 0 delta.
        if (input.cost > 0) {
          const debited = await txDb
            .update(pgSchema.players)
            .set({ credits: sql`${pgSchema.players.credits} - ${input.cost}` })
            .where(
              and(
                eq(pgSchema.players.id, input.playerId),
                sql`${pgSchema.players.credits} >= ${input.cost}`,
              ),
            )
            .returning({ id: pgSchema.players.id });
          if (debited.length === 0) {
            const after = await identity.findPlayerById(input.playerId);
            throw new InsufficientCreditsError(input.playerId, after?.credits ?? 0, input.cost);
          }
        }

        // 4. Restore hull + shields to class max.
        const updated = await txDb
          .update(pgSchema.ships)
          .set({ hull: input.maxHull, shields: input.maxShields })
          .where(eq(pgSchema.ships.id, input.shipId))
          .returning();
        const first = updated[0];
        if (!first) {
          throw new Error(`repairShip: row vanished after update id=${input.shipId}`);
        }
        return mapShip(first);
      });
    },
  };
}
