/**
 * Row mappers for the Postgres repository.
 *
 * Postgres returns native `Date` objects for `timestamptz` columns and
 * `jsonb` payloads as already-parsed JS values. The only normalisation
 * needed is coercing raw rows into the driver-agnostic `*Row` types
 * defined in `./types.ts`.
 */
import {
  IDENTITY_QUATERNION,
  ShipLiverySchema,
  ShipPositionSchema,
  ShipQuaternionSchema,
  ShipRegimeSchema,
  ShipVelocitySchema,
  type PlayerRow,
  type ResourceNodeStateRow,
  type SessionRow,
  type ShipClassId,
  type ShipQuaternion,
  type ShipRegime,
  type ShipRow,
  type SystemRegistryRow,
} from "./types.js";
import { parseDate } from "./repo.helpers.js";
import { emptyInventory, validateInventory } from "@shared/world/inventoryOps.js";
import type { Inventory } from "@shared/world/inventory.js";

/**
 * Read the persisted `inventory` jsonb column (or default to empty).
 * The column is nullable for pre-TASK-34 rows; we replace null /
 * malformed payloads with `emptyInventory()` so a server upgrade runs
 * unmigrated rows without crashing.
 */
function readInventoryColumn(raw: unknown): Inventory {
  if (raw === null || raw === undefined) return emptyInventory();
  if (validateInventory(raw)) return raw;
  return emptyInventory();
}

/** Map a raw players row to the driver-agnostic shape. */
export function mapPlayer(raw: Record<string, unknown>): PlayerRow {
  return {
    id: String(raw.id),
    callsign: String(raw.callsign),
    credits: Number(raw.credits),
    homeSystemId:
      raw.homeSystemId === null || raw.homeSystemId === undefined ? null : String(raw.homeSystemId),
    inventory: readInventoryColumn(raw.inventory),
    createdAt: parseDate(raw.createdAt),
  };
}

/** Map a raw ships row to the driver-agnostic shape. */
export function mapShip(raw: Record<string, unknown>): ShipRow {
  return {
    id: String(raw.id),
    ownerId: String(raw.ownerId),
    classId: raw.classId as ShipClassId,
    livery: ShipLiverySchema.parse(raw.livery),
    hull: Number(raw.hull),
    shields: Number(raw.shields),
    position: ShipPositionSchema.parse(raw.position),
    velocity: ShipVelocitySchema.parse(raw.velocity),
    state: raw.state as ShipRow["state"],
    // TASK-24: parse JSON tuple (quat), text (regime), nullable strings,
    // and timestamp fields. Pre-TASK-24 rows have null columns, so we
    // default to identity quat and null regime/pad/expiry to bridge
    // boot continuity for ships persisted by older code.
    quat: parseShipQuaternion(raw.quat),
    regime: parseShipRegime(raw.regime),
    onPad: raw.onPad === null || raw.onPad === undefined ? null : String(raw.onPad),
    wreckExpiresAt:
      raw.wreckExpiresAt === null || raw.wreckExpiresAt === undefined
        ? null
        : parseDate(raw.wreckExpiresAt).getTime(),
    updatedAt: parseDate(raw.updatedAt),
  };
}

/**
 * Parse the `quat` jsonb column into a `ShipQuaternion` — defaults to
 * identity when the column is null (pre-TASK-24 row).
 */
function parseShipQuaternion(raw: unknown): ShipQuaternion {
  if (raw === null || raw === undefined) return [...IDENTITY_QUATERNION];
  try {
    const parsed = ShipQuaternionSchema.parse(raw);
    return [parsed[0], parsed[1], parsed[2], parsed[3]];
  } catch {
    return [...IDENTITY_QUATERNION];
  }
}

/**
 * Parse the `regime` enum column — defaults to `null` so a restart of
 * a pre-TASK-24 row resumes in regime-less mode (the integrator will
 * fall back to "space" on first tick).
 */
function parseShipRegime(raw: unknown): ShipRegime | null {
  if (raw === null || raw === undefined) return null;
  try {
    return ShipRegimeSchema.parse(String(raw));
  } catch {
    return null;
  }
}

/** Map a raw sessions row to the driver-agnostic shape. */
export function mapSession(raw: Record<string, unknown>): SessionRow {
  return {
    tokenHash: String(raw.tokenHash),
    playerId: String(raw.playerId),
    systemId: raw.systemId === null || raw.systemId === undefined ? null : String(raw.systemId),
    createdAt: parseDate(raw.createdAt),
    expiresAt: parseDate(raw.expiresAt),
  };
}

/** Map a raw resource_node_state row to the driver-agnostic shape. */
export function mapNodeState(raw: Record<string, unknown>): ResourceNodeStateRow {
  return {
    nodeId: String(raw.nodeId),
    quantityRemaining: Number(raw.quantityRemaining),
    respawnAt:
      raw.respawnAt === null || raw.respawnAt === undefined ? null : parseDate(raw.respawnAt),
    systemId: raw.systemId === null || raw.systemId === undefined ? null : String(raw.systemId),
  };
}

/** Map a raw system_registry row to the driver-agnostic shape. */
export function mapSystemRegistry(raw: Record<string, unknown>): SystemRegistryRow {
  return {
    systemId: String(raw.systemId),
    name: String(raw.name),
    shardActive: Boolean(raw.shardActive),
    lastActiveAt: parseDate(raw.lastActiveAt),
  };
}
