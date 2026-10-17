/**
 * Credit-balance helpers used by both the public `addCredits` /
 * `withdrawCredits` methods and the `runInTransaction` callback. The
 * SQL is identical in both cases; the only difference is whether the
 * handle is the regular Drizzle instance or a transactional one.
 *
 * Extracted from `repo.sqlite.world.ts` so the world-binding file
 * stays focused on orchestration and doesn't carry the SQL strings.
 */
import { eq, and, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sqliteSchema } from "./schema.sqlite.js";
import { InsufficientCreditsError, NotFoundError } from "./errors.js";
import { assertPositiveInt } from "./repo.helpers.js";

/**
 * Slim "credit row" projection returned by transaction-bound helpers.
 * Avoids the cost of mapping a full `PlayerRow` when the callback only
 * needs `{ id, credits }` (e.g. the dock-sell flow in TASK-40).
 */
export interface PlayerCreditSlice {
  id: string;
  credits: number;
}

/**
 * Synchronous credit helpers exposed to a `runInTransaction` callback.
 *
 * The callback is invoked inside a `BEGIN ... COMMIT` block; if it
 * throws, every credit write the callback issued is rolled back. The
 * two methods are intentionally limited to credit mutations because
 * the only TASK-41 use case is "withdraw + record an audit row"; a
 * future TASK (e.g. TASK-40 dock selling) extends this with cargo
 * + node-state helpers as needed.
 */
export interface SqliteCreditHandle {
  addCredits: (playerId: string, amount: number) => PlayerCreditSlice;
  withdrawCredits: (playerId: string, amount: number) => PlayerCreditSlice;
}

/**
 * Internal: synchronously add `amount` to a player's balance using the
 * given (possibly transactional) Drizzle handle. Throws `NotFoundError`
 * if the player row does not exist.
 */
export function sqliteAddSync(
  handle: BetterSQLite3Database<typeof sqliteSchema>,
  playerId: string,
  amount: number,
): PlayerCreditSlice {
  assertPositiveInt(amount, "addCredits");
  const update = handle
    .update(sqliteSchema.players)
    .set({ credits: sql`${sqliteSchema.players.credits} + ${amount}` })
    .where(eq(sqliteSchema.players.id, playerId))
    .run();
  if ((update.changes ?? 0) === 0) throw new NotFoundError("Player", playerId);
  const rows = handle
    .select()
    .from(sqliteSchema.players)
    .where(eq(sqliteSchema.players.id, playerId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) throw new NotFoundError("Player", playerId);
  return { id: String(row.id), credits: Number(row.credits) };
}

/**
 * Internal: synchronously debit `amount` from a player's balance using
 * the given Drizzle handle. Throws `InsufficientCreditsError` if the
 * balance is below the request; throws `NotFoundError` if the player
 * does not exist. The `credits >= ?` guard makes the operation atomic
 * with respect to concurrent withdrawals — better-sqlite3 serializes
 * writes so the guard's compare-and-swap is race-free.
 */
export function sqliteWithdrawSync(
  handle: BetterSQLite3Database<typeof sqliteSchema>,
  playerId: string,
  amount: number,
): PlayerCreditSlice {
  assertPositiveInt(amount, "withdrawCredits");
  const update = handle
    .update(sqliteSchema.players)
    .set({ credits: sql`${sqliteSchema.players.credits} - ${amount}` })
    .where(
      and(eq(sqliteSchema.players.id, playerId), sql`${sqliteSchema.players.credits} >= ${amount}`),
    )
    .run();
  if ((update.changes ?? 0) === 0) {
    const rows = handle
      .select()
      .from(sqliteSchema.players)
      .where(eq(sqliteSchema.players.id, playerId))
      .limit(1)
      .all();
    const existing = rows[0];
    if (!existing) throw new NotFoundError("Player", playerId);
    throw new InsufficientCreditsError(playerId, Number(existing.credits), amount);
  }
  const rows = handle
    .select()
    .from(sqliteSchema.players)
    .where(eq(sqliteSchema.players.id, playerId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) throw new NotFoundError("Player", playerId);
  return { id: String(row.id), credits: Number(row.credits) };
}
