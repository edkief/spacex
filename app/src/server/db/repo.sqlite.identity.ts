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
import { ShipLiverySchema, ShipPositionSchema, ShipVelocitySchema } from "./types.js";
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
import { clampInt, isoNow, mapUniqueViolation } from "./repo.helpers.js";
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
      const existing = await this.findShipById(id);
      if (!existing) {
        throw new NotFoundError("Ship", id);
      }
      const update: Partial<typeof sqliteSchema.ships.$inferInsert> = {
        updatedAt: isoNow(),
      };
      if (patch.hull !== undefined) update.hull = clampInt(patch.hull, 0, 100);
      if (patch.shields !== undefined) update.shields = clampInt(patch.shields, 0, 100);
      if (patch.position !== undefined) {
        update.position = JSON.stringify(ShipPositionSchema.parse(patch.position));
      }
      if (patch.velocity !== undefined) {
        update.velocity = JSON.stringify(ShipVelocitySchema.parse(patch.velocity));
      }
      if (patch.state !== undefined) update.state = patch.state;
      if (patch.livery !== undefined) {
        update.livery = JSON.stringify(ShipLiverySchema.parse(patch.livery));
      }
      await db.update(sqliteSchema.ships).set(update).where(eq(sqliteSchema.ships.id, id)).run();
      const refreshed = await this.findShipById(id);
      if (!refreshed) {
        throw new Error(`saveShipState: row vanished after update id=${id}`);
      }
      return refreshed;
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
