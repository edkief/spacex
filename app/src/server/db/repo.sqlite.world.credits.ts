/**
 * Credit + ship replacement helpers used by both the public methods
 * (`addCredits`, `withdrawCredits`, `purchaseShip`) and the
 * `runInTransaction` callback. The SQL is identical in both cases;
 * the only difference is whether the handle is the regular Drizzle
 * instance or a transactional one.
 *
 * Extracted from `repo.sqlite.world.ts` so the world-binding file
 * stays focused on orchestration and doesn't carry the SQL strings.
 */
import { eq, and, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import { sqliteSchema } from "./schema.sqlite.js";
import { InsufficientCreditsError, NotFoundError } from "./errors.js";
import type { ShipClassId, ShipLivery, ShipPosition, ShipRow } from "./types.js";
import { ShipLiverySchema, ShipPositionSchema } from "./types.js";
import { assertPositiveInt } from "./repo.helpers.js";
import { mapShip } from "./repo.sqlite.mappers.js";
import {
  AlreadyOwnedShipError,
  NotDockedError,
  ZERO_VELOCITY,
  defaultPosition,
  type ShipReplacementHandle,
} from "./repo.js";

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
 * Synchronous credit + ship replacement helpers exposed to a
 * `runInTransaction` callback.
 *
 * The callback is invoked inside a `BEGIN ... COMMIT` block; if it
 * throws, every credit / ship write the callback issued is rolled
 * back. The credit methods cover the TASK-41 use case; the ship
 * replacement covers TASK-20 (atomic buy at the dock).
 */
export interface SqliteCreditHandle extends ShipReplacementHandle {
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

/**
 * Synchronously replace the player's owned ship with a new row.
 * Deletes the existing `ships` row (cascade-deletes its `cargo_items`)
 * and inserts a fresh row for `classId`. State is forced to `"docked"`
 * (the caller is responsible for validating the player was docked).
 *
 * Position is re-anchored at the player's home system origin. Livery is
 * whatever the caller passed in (the route maps starter-class buyers to
 * the default livery; mid-flight colour customisations apply once TASK-21
 * lands). Velocity is zero.
 *
 * Throws `NotFoundError` if the player has no row. The transaction
 * wrapper in `runInTransaction` is what gives this whole thing its
 * atomicity — if the credit withdraw failed earlier, this method
 * will never be reached, and if it itself throws, nothing is left
 * half-applied.
 */
export function sqliteReplaceShip(
  handle: BetterSQLite3Database<typeof sqliteSchema>,
  playerId: string,
  classId: ShipClassId,
  hull: number,
  shields: number,
  livery: ShipLivery,
): ShipRow {
  const playerRows = handle
    .select({ id: sqliteSchema.players.id, homeSystemId: sqliteSchema.players.homeSystemId })
    .from(sqliteSchema.players)
    .where(eq(sqliteSchema.players.id, playerId))
    .limit(1)
    .all();
  const player = playerRows[0];
  if (!player) throw new NotFoundError("Player", playerId);
  const homeSystemId = player.homeSystemId ?? "";

  // Defence-in-depth: re-parse the inputs we received from the caller
  // through zod so a buggy route can't sneak garbage into the table.
  ShipLiverySchema.parse(livery);
  const position: ShipPosition = ShipPositionSchema.parse(defaultPosition(homeSystemId));

  // Delete the old ship — `cargo_items` cascade via the schema's FK.
  handle.delete(sqliteSchema.ships).where(eq(sqliteSchema.ships.ownerId, playerId)).run();
  const id = randomUUID();
  handle
    .insert(sqliteSchema.ships)
    .values({
      id,
      ownerId: playerId,
      classId,
      livery: JSON.stringify(livery),
      hull,
      shields,
      position: JSON.stringify(position),
      velocity: JSON.stringify(ZERO_VELOCITY),
      state: "docked",
    })
    .run();
  const inserted = handle
    .select()
    .from(sqliteSchema.ships)
    .where(eq(sqliteSchema.ships.id, id))
    .limit(1)
    .all();
  const insertedRow = inserted[0];
  if (!insertedRow) throw new NotFoundError("Ship", id);
  return mapShip(insertedRow);
}

/**
 * Re-export the typed business errors so the world-binding file can
 * `import { ... } from "./repo.sqlite.world.credits.js"` without a
 * separate path.
 */
export { AlreadyOwnedShipError, NotDockedError };
