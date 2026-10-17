/**
 * SQLite repository — identity-domain methods (players + ships + cargo).
 *
 * Implementation methods for operations that operate on per-player state.
 * The "world" methods (credits, resource nodes, sessions, system registry)
 * live in `./repo.sqlite.world.ts`. The top-level factory
 * (`repo.sqlite.ts`) composes the two.
 */
import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import { sqliteSchema } from "./schema.sqlite.js";
import {
  IDENTITY_QUATERNION,
  ShipLiverySchema,
  ShipPositionSchema,
  ShipQuaternionSchema,
  ShipRegimeSchema,
  ShipVelocitySchema,
} from "./types.js";
import type {
  CargoItemInput,
  CargoItemRow,
  CreatePlayerInput,
  PlayerRow,
  SaveShipStateInput,
  ShipClassId,
  ShipRow,
} from "./types.js";
import { NotFoundError } from "./errors.js";
import { clampInt, isoFromMs, isoNow, mapUniqueViolation } from "./repo.helpers.js";
import { mapPlayer, mapShip } from "./repo.sqlite.mappers.js";
import {
  DEFAULT_LIVERY,
  STARTER_HULL,
  STARTER_SHIELDS,
  ZERO_VELOCITY,
  defaultPosition,
} from "./repo.js";

/**
 * Bind player/ship/cargo query methods to the given SQLite database.
 *
 * Implemented as a partial repo because the world sub-binding (`credits`,
 * `nodes`, `sessions`, `registry`) threads `findPlayerById` back into
 * this side via the factory — we don't need the world impl as an input,
 * only the public player-lookup methods on `this`.
 */
export function bindSqliteIdentity(db: BetterSQLite3Database<typeof sqliteSchema>): {
  createPlayer: (input: CreatePlayerInput) => Promise<PlayerRow>;
  findPlayerByCallsign: (callsign: string) => Promise<PlayerRow | null>;
  findPlayerById: (id: string) => Promise<PlayerRow | null>;
  getOrCreateStarterShip: (playerId: string, classId: ShipClassId) => Promise<ShipRow>;
  findShipById: (id: string) => Promise<ShipRow | null>;
  saveShipState: (id: string, patch: SaveShipStateInput) => Promise<ShipRow>;
  listShipsByOwner: (ownerId: string) => Promise<ShipRow[]>;
  listShipsBySystem: (systemId: string) => Promise<ShipRow[]>;
  listLiveShipsBySystem: (systemId: string, nowMs: number) => Promise<ShipRow[]>;
  deleteExpiredWrecks: (systemId: string, nowMs: number) => Promise<number>;
  saveCargo: (shipId: string, items: CargoItemInput[]) => Promise<CargoItemRow[]>;
  listCargoByShip: (shipId: string) => Promise<CargoItemRow[]>;
} {
  return {
    async createPlayer(input: CreatePlayerInput): Promise<PlayerRow> {
      const id = randomUUID();
      try {
        await db
          .insert(sqliteSchema.players)
          .values({
            id,
            callsign: input.callsign,
            homeSystemId: input.homeSystemId,
            credits: 500,
          })
          .run();
      } catch (err) {
        throw mapUniqueViolation(err, input.callsign);
      }
      const row = await this.findPlayerById(id);
      if (!row) {
        throw new Error(`createPlayer: row vanished after insert for id=${id}`);
      }
      return row;
    },

    async findPlayerByCallsign(callsign: string): Promise<PlayerRow | null> {
      const rows = await db
        .select()
        .from(sqliteSchema.players)
        .where(eq(sqliteSchema.players.callsign, callsign))
        .limit(1);
      return rows[0] ? mapPlayer(rows[0]) : null;
    },

    async findPlayerById(id: string): Promise<PlayerRow | null> {
      const rows = await db
        .select()
        .from(sqliteSchema.players)
        .where(eq(sqliteSchema.players.id, id))
        .limit(1);
      return rows[0] ? mapPlayer(rows[0]) : null;
    },

    async getOrCreateStarterShip(playerId: string, classId: ShipClassId): Promise<ShipRow> {
      const existing = await db
        .select()
        .from(sqliteSchema.ships)
        .where(eq(sqliteSchema.ships.ownerId, playerId))
        .limit(1);
      if (existing[0]) return mapShip(existing[0]);

      const player = await this.findPlayerById(playerId);
      if (!player) {
        throw new NotFoundError("Player", playerId);
      }
      const id = randomUUID();
      const position = defaultPosition(player.homeSystemId ?? "");
      await db
        .insert(sqliteSchema.ships)
        .values({
          id,
          ownerId: playerId,
          classId,
          livery: JSON.stringify(DEFAULT_LIVERY),
          hull: STARTER_HULL,
          shields: STARTER_SHIELDS,
          position: JSON.stringify(position),
          velocity: JSON.stringify(ZERO_VELOCITY),
          state: "docked",
          // TASK-24: starter ships materialise with identity orientation
          // and no regime / pad / wreck TTL. The quat / regime / on_pad /
          // wreck_expires_at columns are nullable so pre-TASK-24 rows
          // backfill to "in space at origin facing +Z" on read.
          quat: JSON.stringify(IDENTITY_QUATERNION),
          regime: null,
          onPad: null,
          wreckExpiresAt: null,
        })
        .run();
      const row = await this.findShipById(id);
      if (!row) {
        throw new Error(`getOrCreateStarterShip: row vanished after insert id=${id}`);
      }
      return row;
    },

    async findShipById(id: string): Promise<ShipRow | null> {
      const rows = await db
        .select()
        .from(sqliteSchema.ships)
        .where(eq(sqliteSchema.ships.id, id))
        .limit(1);
      return rows[0] ? mapShip(rows[0]) : null;
    },

    async saveShipState(id: string, patch: SaveShipStateInput): Promise<ShipRow> {
      // Read the existing row once, apply the patch in memory, and
      // return the merged shape — avoids the previous 2× SELECT +
      // UPDATE round-trip pattern that cost ~9 ms for the 16-ship
      // flush benchmark. The pre-update SELECT remains so we still
      // raise `NotFoundError` for unknown ships; the post-update
      // SELECT was pure overhead (the patch already contains every
      // changed field).
      const existing = await this.findShipById(id);
      if (!existing) {
        throw new NotFoundError("Ship", id);
      }
      const update: Partial<typeof sqliteSchema.ships.$inferInsert> = {
        updatedAt: isoNow(),
      };
      let merged: ShipRow = { ...existing, updatedAt: new Date() };
      if (patch.hull !== undefined) {
        const hull = clampInt(patch.hull, 0, 100);
        update.hull = hull;
        merged = { ...merged, hull };
      }
      if (patch.shields !== undefined) {
        const shields = clampInt(patch.shields, 0, 100);
        update.shields = shields;
        merged = { ...merged, shields };
      }
      if (patch.position !== undefined) {
        const position = ShipPositionSchema.parse(patch.position);
        update.position = JSON.stringify(position);
        merged = { ...merged, position };
      }
      if (patch.velocity !== undefined) {
        const velocity = ShipVelocitySchema.parse(patch.velocity);
        update.velocity = JSON.stringify(velocity);
        merged = { ...merged, velocity };
      }
      if (patch.state !== undefined) {
        update.state = patch.state;
        merged = { ...merged, state: patch.state };
      }
      if (patch.livery !== undefined) {
        const livery = ShipLiverySchema.parse(patch.livery);
        update.livery = JSON.stringify(livery);
        merged = { ...merged, livery };
      }
      // TASK-24 persistence: orientation + flight regime + pad id + wreck
      // TTL. Saving is one row UPDATE per ship — the spec calls out that
      // a hot-path write must be "one UPDATE per ship, no WAL checkpoint
      // inside" so the entire batch is small enough to fit in a single
      // transaction.
      if (patch.quat !== undefined) {
        const quat = ShipQuaternionSchema.parse(patch.quat);
        update.quat = JSON.stringify(quat);
        merged = { ...merged, quat };
      }
      if (patch.regime !== undefined) {
        const regime = patch.regime === null ? null : ShipRegimeSchema.parse(patch.regime);
        update.regime = regime;
        merged = { ...merged, regime };
      }
      if (patch.onPad !== undefined) {
        const onPad = patch.onPad === null ? null : patch.onPad;
        update.onPad = onPad;
        merged = { ...merged, onPad };
      }
      if (patch.wreckExpiresAt !== undefined) {
        const wreckExpiresAt =
          patch.wreckExpiresAt === null ? null : isoFromMs(patch.wreckExpiresAt);
        update.wreckExpiresAt = wreckExpiresAt;
        merged = { ...merged, wreckExpiresAt: patch.wreckExpiresAt };
      }
      await db.update(sqliteSchema.ships).set(update).where(eq(sqliteSchema.ships.id, id)).run();
      return merged;
    },

    async listShipsByOwner(ownerId: string): Promise<ShipRow[]> {
      const rows = await db
        .select()
        .from(sqliteSchema.ships)
        .where(eq(sqliteSchema.ships.ownerId, ownerId));
      return rows.map(mapShip);
    },

    async listShipsBySystem(systemId: string): Promise<ShipRow[]> {
      // json_extract is the cheapest deterministic way to filter on a JSON
      // field stored as TEXT; avoids scanning the whole table when the
      // systemId matches the persisted position.systemId.
      const rows = await db
        .select()
        .from(sqliteSchema.ships)
        .where(sql`json_extract(${sqliteSchema.ships.position}, '$.systemId') = ${systemId}`);
      return rows.map(mapShip);
    },

    async listLiveShipsBySystem(systemId: string, nowMs: number): Promise<ShipRow[]> {
      // TASK-24: hydrate a freshly-spawned shard with every ship whose
      // `position.systemId` matches. We keep wrecks whose `wreck_expires_at`
      // is in the future so the renderer can draw them until cleanup.
      // `wreck_expires_at` is stored as ISO-8601 TEXT so we compare
      // against the same format from `isoFromMs(nowMs)`. Pre-TASK-24
      // rows have `state` only (no `wreck_expires_at`) — they read
      // correctly because `wreck_expires_at` is null which falls
      // through the second condition cleanly.
      const nowIso = isoFromMs(nowMs);
      const rows = await db
        .select()
        .from(sqliteSchema.ships)
        .where(
          sql`json_extract(${sqliteSchema.ships.position}, '$.systemId') = ${systemId}
              AND (
                  ${sqliteSchema.ships.state} != 'destroyed'
                  OR (${sqliteSchema.ships.state} = 'destroyed'
                      AND ${sqliteSchema.ships.wreckExpiresAt} IS NOT NULL
                      AND ${sqliteSchema.ships.wreckExpiresAt} > ${nowIso})
              )`,
        );
      return rows.map(mapShip);
    },

    async deleteExpiredWrecks(systemId: string, nowMs: number): Promise<number> {
      // TASK-24 destruction persistence: clean rows whose wreck TTL has
      // elapsed so a restart never sees orphan wreck rows. The filter
      // scopes by systemId so an unload of one system doesn't trash the
      // wrecks of an inactive sibling.
      const nowIso = isoFromMs(nowMs);
      const result = db
        .delete(sqliteSchema.ships)
        .where(
          sql`json_extract(${sqliteSchema.ships.position}, '$.systemId') = ${systemId}
              AND ${sqliteSchema.ships.state} = 'destroyed'
              AND ${sqliteSchema.ships.wreckExpiresAt} IS NOT NULL
              AND ${sqliteSchema.ships.wreckExpiresAt} <= ${nowIso}`,
        )
        .run();
      return result.changes ?? 0;
    },

    async saveCargo(shipId: string, items: CargoItemInput[]): Promise<CargoItemRow[]> {
      const existing = await this.findShipById(shipId);
      if (!existing) {
        throw new NotFoundError("Ship", shipId);
      }
      // Wipe-and-replace semantics. A differential variant can layer on top
      // later if the manifest grows large.
      //
      // Wrap the DELETE + N INSERTs in `db.transaction(...)` so the manifest
      // update is one logical write — TASK-63 AC4 ("one transaction per save
      // point, not per field") demands atomicity for multi-row cargo updates.
      const valid = items.filter((it) => it.quantity > 0);
      const inserted: Array<{ id: string; resourceType: string; quantity: number }> = [];
      // Drizzle's transaction helper returns the callback's value. better-sqlite3
      // is sync, so the async signature here is a Promise-wrapped surface; we
      // resolve with the rows we collected inside the txn.
      db.transaction((tx) => {
        tx.delete(sqliteSchema.cargoItems).where(eq(sqliteSchema.cargoItems.shipId, shipId)).run();
        for (const item of valid) {
          const id = randomUUID();
          tx.insert(sqliteSchema.cargoItems)
            .values({
              id,
              shipId,
              resourceType: item.resourceType,
              quantity: item.quantity,
            })
            .run();
          inserted.push({
            id,
            resourceType: item.resourceType,
            quantity: item.quantity,
          });
        }
      });
      return inserted.map((r) => ({
        id: r.id,
        shipId,
        resourceType: r.resourceType,
        quantity: r.quantity,
      }));
    },

    async listCargoByShip(shipId: string): Promise<CargoItemRow[]> {
      const rows = await db
        .select()
        .from(sqliteSchema.cargoItems)
        .where(eq(sqliteSchema.cargoItems.shipId, shipId));
      return rows.map((r) => ({
        id: String(r.id),
        shipId: String(r.shipId),
        resourceType: String(r.resourceType),
        quantity: Number(r.quantity),
      }));
    },
  };
}
