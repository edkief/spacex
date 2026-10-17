/**
 * Postgres repository — identity-domain methods (players + ships + cargo).
 *
 * Postgres-specific: uses native `timestamptz` → Date columns, server-
 * side `defaultRandom()` for UUID PKs, and `.returning()` to read back
 * inserted rows in a single round-trip.
 *
 * The "world" methods (credits, resource nodes, sessions, system
 * registry) live in `./repo.pg.world.ts`. The top-level factory
 * (`repo.pg.ts`) composes the two.
 */
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgSchema } from "./schema.pg.js";
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
import { clampInt, mapUniqueViolation } from "./repo.helpers.js";
import { mapPlayer, mapShip } from "./repo.pg.mappers.js";
import {
  DEFAULT_LIVERY,
  STARTER_HULL,
  STARTER_SHIELDS,
  ZERO_VELOCITY,
  defaultPosition,
} from "./repo.js";

/**
 * Bind player/ship/cargo query methods to the given Postgres database.
 *
 * Identity methods need access to one world method — `findPlayerById` —
 * via the factory's two-phase binding (see `repo.pg.ts` for the wiring).
 */
export function bindPgIdentity(db: NodePgDatabase<typeof pgSchema>): {
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
      // Postgres uses server-side uuid default; we let the DB mint it.
      try {
        const rows = await db
          .insert(pgSchema.players)
          .values({
            callsign: input.callsign,
            homeSystemId: input.homeSystemId,
            credits: 500,
          })
          .returning();
        const first = rows[0];
        if (!first) throw new Error("insert returned no rows");
        return mapPlayer(first);
      } catch (err) {
        throw mapUniqueViolation(err, input.callsign);
      }
    },

    async findPlayerByCallsign(callsign: string): Promise<PlayerRow | null> {
      const rows = await db
        .select()
        .from(pgSchema.players)
        .where(eq(pgSchema.players.callsign, callsign))
        .limit(1);
      return rows[0] ? mapPlayer(rows[0]) : null;
    },

    async findPlayerById(id: string): Promise<PlayerRow | null> {
      const rows = await db
        .select()
        .from(pgSchema.players)
        .where(eq(pgSchema.players.id, id))
        .limit(1);
      return rows[0] ? mapPlayer(rows[0]) : null;
    },

    async getOrCreateStarterShip(playerId: string, classId: ShipClassId): Promise<ShipRow> {
      const existing = await db
        .select()
        .from(pgSchema.ships)
        .where(eq(pgSchema.ships.ownerId, playerId))
        .limit(1);
      if (existing[0]) return mapShip(existing[0]);
      const player = await this.findPlayerById(playerId);
      if (!player) throw new NotFoundError("Player", playerId);
      const position = defaultPosition(player.homeSystemId ?? "");
      const rows = await db
        .insert(pgSchema.ships)
        .values({
          ownerId: playerId,
          classId,
          livery: DEFAULT_LIVERY,
          hull: STARTER_HULL,
          shields: STARTER_SHIELDS,
          position,
          velocity: ZERO_VELOCITY,
          state: "docked",
        })
        .returning();
      const first = rows[0];
      if (!first) throw new Error("insert returned no rows");
      return mapShip(first);
    },

    async findShipById(id: string): Promise<ShipRow | null> {
      const rows = await db.select().from(pgSchema.ships).where(eq(pgSchema.ships.id, id)).limit(1);
      return rows[0] ? mapShip(rows[0]) : null;
    },

    async saveShipState(id: string, patch: SaveShipStateInput): Promise<ShipRow> {
      const existing = await this.findShipById(id);
      if (!existing) throw new NotFoundError("Ship", id);
      const update: Partial<typeof pgSchema.ships.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.hull !== undefined) update.hull = clampInt(patch.hull, 0, 100);
      if (patch.shields !== undefined) update.shields = clampInt(patch.shields, 0, 100);
      if (patch.position !== undefined) {
        update.position = ShipPositionSchema.parse(patch.position);
      }
      if (patch.velocity !== undefined) {
        update.velocity = ShipVelocitySchema.parse(patch.velocity);
      }
      if (patch.state !== undefined) update.state = patch.state;
      if (patch.livery !== undefined) {
        update.livery = ShipLiverySchema.parse(patch.livery);
      }
      const rows = await db
        .update(pgSchema.ships)
        .set(update)
        .where(eq(pgSchema.ships.id, id))
        .returning();
      const first = rows[0];
      if (!first) throw new Error("update returned no rows");
      return mapShip(first);
    },

    async listShipsByOwner(ownerId: string): Promise<ShipRow[]> {
      const rows = await db
        .select()
        .from(pgSchema.ships)
        .where(eq(pgSchema.ships.ownerId, ownerId));
      return rows.map(mapShip);
    },

    async listShipsBySystem(systemId: string): Promise<ShipRow[]> {
      // jsonb `->>'systemId'` lookup — equivalent to SQLite's json_extract.
      const rows = await db
        .select()
        .from(pgSchema.ships)
        .where(sql`${pgSchema.ships.position}->>'systemId' = ${systemId}`);
      return rows.map(mapShip);
    },

    async saveCargo(shipId: string, items: CargoItemInput[]): Promise<CargoItemRow[]> {
      const existing = await this.findShipById(shipId);
      if (!existing) throw new NotFoundError("Ship", shipId);
      await db.delete(pgSchema.cargoItems).where(eq(pgSchema.cargoItems.shipId, shipId));
      const rows: CargoItemRow[] = [];
      for (const item of items) {
        if (item.quantity <= 0) continue;
        const rowsOut = await db
          .insert(pgSchema.cargoItems)
          .values({
            shipId,
            resourceType: item.resourceType,
            quantity: item.quantity,
          })
          .returning();
        const first = rowsOut[0];
        if (!first) throw new Error("insert returned no rows");
        rows.push({
          id: first.id,
          shipId,
          resourceType: item.resourceType,
          quantity: item.quantity,
        });
      }
      return rows;
    },

    async listCargoByShip(shipId: string): Promise<CargoItemRow[]> {
      const rows = await db
        .select()
        .from(pgSchema.cargoItems)
        .where(eq(pgSchema.cargoItems.shipId, shipId));
      return rows.map((r) => ({
        id: String(r.id),
        shipId: String(r.shipId),
        resourceType: String(r.resourceType),
        quantity: Number(r.quantity),
      }));
    },
  };
}
