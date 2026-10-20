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
import { clampInt, mapUniqueViolation } from "./repo.helpers.js";
import { mapPlayer, mapShip } from "./repo.pg.mappers.js";
import {
  DEFAULT_LIVERY,
  STARTER_HULL,
  STARTER_SHIELDS,
  ZERO_VELOCITY,
  defaultPosition,
} from "./repo.js";
import { emptyInventory, validateInventory } from "@shared/world/inventoryOps.js";
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from "@shared/settings.js";
import type { Inventory } from "@shared/world/inventory.js";
import { cargoHoldFor } from "@shared/world/cargo.js";
import { validateCargoHold } from "@shared/world/cargoOps.js";

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
  getInventory: (playerId: string) => Promise<Inventory>;
  saveInventory: (playerId: string, inventory: Inventory) => Promise<Inventory>;
  getSettings: (playerId: string) => Promise<Settings>;
  saveSettings: (playerId: string, settings: Settings) => Promise<Settings>;
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
      // Postgres uses server-side uuid default; we let the DB mint it.
      try {
        const rows = await db
          .insert(pgSchema.players)
          .values({
            callsign: input.callsign,
            homeSystemId: input.homeSystemId,
            credits: 500,
            // TASK-34: starting inventory is empty. The column is
            // nullable so the loader would default to empty on a null;
            // we set it explicitly here so the row is readable without
            // a fallback branch.
            inventory: emptyInventory(),
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

    async getInventory(playerId: string): Promise<Inventory> {
      // Null → empty inventory; malformed JSON / out-of-range weight
      // also resolves to empty (defensive — drops the bad row but
      // keeps the player functional). Unknown player → NotFoundError.
      const rows = await db
        .select({ inventory: pgSchema.players.inventory })
        .from(pgSchema.players)
        .where(eq(pgSchema.players.id, playerId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new NotFoundError("Player", playerId);
      }
      const raw = row.inventory;
      if (raw === null || raw === undefined) return emptyInventory();
      if (validateInventory(raw)) return raw as Inventory;
      return emptyInventory();
    },

    async saveInventory(playerId: string, inventory: Inventory): Promise<Inventory> {
      if (!validateInventory(inventory)) {
        throw new Error("saveInventory: invalid inventory shape");
      }
      const result = await db
        .update(pgSchema.players)
        .set({ inventory })
        .where(eq(pgSchema.players.id, playerId))
        .returning({ id: pgSchema.players.id });
      if (result.length === 0) {
        throw new NotFoundError("Player", playerId);
      }
      return inventory;
    },

    // TASK-55: per-player settings (jsonb). NULL (pre-TASK-55 row)
    // or a malformed payload resolves to the shipped defaults.
    async getSettings(playerId: string): Promise<Settings> {
      const rows = await db
        .select({ settings: pgSchema.players.settings })
        .from(pgSchema.players)
        .where(eq(pgSchema.players.id, playerId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new NotFoundError("Player", playerId);
      }
      const raw = row.settings;
      if (raw === null || raw === undefined) return DEFAULT_SETTINGS;
      return sanitizeSettings(raw);
    },

    async saveSettings(playerId: string, settings: Settings): Promise<Settings> {
      const stored = sanitizeSettings(settings);
      const result = await db
        .update(pgSchema.players)
        .set({ settings: stored })
        .where(eq(pgSchema.players.id, playerId))
        .returning({ id: pgSchema.players.id });
      if (result.length === 0) {
        throw new NotFoundError("Player", playerId);
      }
      return stored;
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
          // TASK-24: starter ships materialise with identity orientation,
          // no regime (the integrator defaults to "space"), no pad, and
          // no wreck TTL.
          quat: [...IDENTITY_QUATERNION],
          regime: null,
          onPad: null,
          wreckExpiresAt: null,
          // TASK-39: starter ships start with an empty cargo hold sized
          // to the class-derived capacity.
          cargo: cargoHoldFor(classId),
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
      // TASK-24 persistence: the orientation quaternion + flight regime
      // + pad id + wreck TTL. Each is one column UPDATE — Postgres jsonb
      // and timestamptz accept the same shapes as the SQLite TEXT columns
      // so the wire / logical shape stays identical between drivers.
      if (patch.quat !== undefined) {
        update.quat = ShipQuaternionSchema.parse(patch.quat);
      }
      if (patch.regime !== undefined) {
        update.regime = patch.regime === null ? null : ShipRegimeSchema.parse(patch.regime);
      }
      if (patch.onPad !== undefined) {
        update.onPad = patch.onPad === null ? null : patch.onPad;
      }
      if (patch.wreckExpiresAt !== undefined) {
        update.wreckExpiresAt =
          patch.wreckExpiresAt === null ? null : new Date(patch.wreckExpiresAt);
      }
      // TASK-39: cargo hold persistence — full-shape replace so the
      // flush is one column UPDATE per save. Same zod guard as the
      // SQLite path so a malformed payload can't round-trip back as a
      // load-time crash.
      if (patch.cargo !== undefined) {
        if (!validateCargoHold(patch.cargo)) {
          throw new Error("saveShipState: invalid cargo hold shape");
        }
        update.cargo = patch.cargo;
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

    async listLiveShipsBySystem(systemId: string, nowMs: number): Promise<ShipRow[]> {
      // TASK-24: hydrate a freshly-spawned shard with every ship whose
      // embedded position.systemId matches. We keep wrecks whose TTL is
      // in the future so the renderer can draw them until cleanup. The
      // jsonb operator + timestamptz comparison keeps both columns in
      // their native types so we don't pay a cast cost per row.
      const rows = await db
        .select()
        .from(pgSchema.ships)
        .where(
          sql`${pgSchema.ships.position}->>'systemId' = ${systemId}
              AND (
                  ${pgSchema.ships.state} <> 'destroyed'
                  OR (${pgSchema.ships.state} = 'destroyed'
                      AND ${pgSchema.ships.wreckExpiresAt} IS NOT NULL
                      AND ${pgSchema.ships.wreckExpiresAt} > ${new Date(nowMs)})
              )`,
        );
      return rows.map(mapShip);
    },

    async deleteExpiredWrecks(systemId: string, nowMs: number): Promise<number> {
      // TASK-24 destruction persistence: clean rows whose wreck TTL has
      // elapsed so a restart never sees orphan wreck rows. Returning a
      // count (instead of rows[]) lets the caller log the GC stats
      // without materialising the doomed entities.
      const rows = await db
        .delete(pgSchema.ships)
        .where(
          sql`${pgSchema.ships.position}->>'systemId' = ${systemId}
              AND ${pgSchema.ships.state} = 'destroyed'
              AND ${pgSchema.ships.wreckExpiresAt} IS NOT NULL
              AND ${pgSchema.ships.wreckExpiresAt} <= ${new Date(nowMs)}`,
        )
        .returning({ id: pgSchema.ships.id });
      return rows.length;
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
