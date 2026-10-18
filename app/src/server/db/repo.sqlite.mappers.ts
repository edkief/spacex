/**
 * Row mappers for the SQLite repository.
 *
 * SQLite stores JSON columns as TEXT and timestamps as ISO strings, so
 * every raw row needs a small translation step before it lands in the
 * driver-agnostic `*Row` types defined in `./types.ts`. Keeping the
 * mappers in a dedicated file lets the implementation file
 * (`repo.sqlite.ts`) stay focused on query construction and business
 * logic.
 */
import {
  IDENTITY_QUATERNION,
  ShipLiverySchema,
  ShipPositionSchema,
  ShipQuaternionSchema,
  ShipRegimeSchema,
  ShipVelocitySchema,
  type DepositStateRow,
  type PlayerRow,
  type ResourceNodeStateRow,
  type SessionRow,
  type ShipClassId,
  type ShipQuaternion,
  type ShipRegime,
  type ShipRow,
  type SystemRegistryRow,
} from "./types.js";
import { emptyInventory, validateInventory } from "@shared/world/inventoryOps.js";
import type { Inventory } from "@shared/world/inventory.js";
import { parseDate, parseJsonField } from "./repo.helpers.js";

/** Raw shape of a `players` row straight from better-sqlite3. */
export interface SqlitePlayerRaw {
  id: string;
  callsign: string;
  credits: number;
  homeSystemId: string | null;
  /** TASK-34: on-foot inventory column (TEXT — JSON serialised). */
  inventory?: string | null;
  createdAt: string;
}

/** Raw shape of a `ships` row straight from better-sqlite3.
 *
 * The TASK-24 additions (quat / regime / on_pad / wreck_expires_at) are
 * stored as nullable TEXT so a SELECT against a pre-TASK-24 row returns
 * `null` here and the mapper can fill in safe defaults (identity quat,
 * null regime, null pad, null expiry).
 */
export interface SqliteShipRaw {
  id: string;
  ownerId: string;
  classId: string;
  livery: string;
  hull: number;
  shields: number;
  position: string;
  velocity: string;
  state: string;
  quat?: string | null;
  regime?: string | null;
  onPad?: string | null;
  wreckExpiresAt?: string | null;
  updatedAt: string;
}

/** Raw shape of a `sessions` row straight from better-sqlite3. */
export interface SqliteSessionRaw {
  tokenHash: string;
  playerId: string;
  systemId: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Raw shape of a `resource_node_state` row straight from better-sqlite3. */
export interface SqliteResourceNodeStateRaw {
  nodeId: string;
  quantityRemaining: number;
  respawnAt: string | null;
  systemId: string | null;
}

/** Raw shape of a `system_registry` row straight from better-sqlite3. */
export interface SqliteSystemRegistryRaw {
  systemId: string;
  name: string;
  shardActive: number | boolean;
  lastActiveAt: string;
}

/**
 * Read the persisted `inventory` column (or default to empty). The
 * column is nullable for pre-TASK-34 rows; the loader replaces
 * `null` / malformed JSON with `emptyInventory()` rather than crash,
 * so a server upgrade can run unmigrated rows without losing
 * ownership of freshly-minted players.
 */
function readInventoryColumn(raw: unknown): Inventory {
  if (raw === null || raw === undefined) return emptyInventory();
  try {
    const parsed = JSON.parse(String(raw));
    if (validateInventory(parsed)) return parsed;
  } catch {
    // fall through
  }
  return emptyInventory();
}

/** Map a raw players row to the driver-agnostic shape. */
export function mapPlayer(raw: SqlitePlayerRaw | Record<string, unknown>): PlayerRow {
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

/** Map a raw ships row to the driver-agnostic shape (parses JSON + zod). */
export function mapShip(raw: SqliteShipRaw | Record<string, unknown>): ShipRow {
  return {
    id: String(raw.id),
    ownerId: String(raw.ownerId),
    classId: raw.classId as ShipClassId,
    livery: ShipLiverySchema.parse(parseJsonField(raw.livery, "livery")),
    hull: Number(raw.hull),
    shields: Number(raw.shields),
    position: ShipPositionSchema.parse(parseJsonField(raw.position, "position")),
    velocity: ShipVelocitySchema.parse(parseJsonField(raw.velocity, "velocity")),
    state: raw.state as ShipRow["state"],
    // TASK-24 additions: parse JSON tuples; default to identity quat and
    // null regime/pad/expiry when the column is null (pre-TASK-24 rows).
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

/** Parse a quat column into a `ShipQuaternion` — defaults to identity. */
function parseShipQuaternion(raw: unknown): ShipQuaternion {
  if (raw === null || raw === undefined) return [...IDENTITY_QUATERNION];
  try {
    const parsed = ShipQuaternionSchema.parse(JSON.parse(String(raw)));
    return [parsed[0], parsed[1], parsed[2], parsed[3]];
  } catch {
    return [...IDENTITY_QUATERNION];
  }
}

/** Parse a regime column into a `ShipRegime | null` — defaults to null. */
function parseShipRegime(raw: unknown): ShipRegime | null {
  if (raw === null || raw === undefined) return null;
  try {
    return ShipRegimeSchema.parse(String(raw));
  } catch {
    return null;
  }
}

/** Map a raw sessions row to the driver-agnostic shape. */
export function mapSession(raw: SqliteSessionRaw | Record<string, unknown>): SessionRow {
  return {
    tokenHash: String(raw.tokenHash),
    playerId: String(raw.playerId),
    systemId: raw.systemId === null || raw.systemId === undefined ? null : String(raw.systemId),
    createdAt: parseDate(raw.createdAt),
    expiresAt: parseDate(raw.expiresAt),
  };
}

/** Map a raw resource_node_state row to the driver-agnostic shape. */
export function mapNodeState(
  raw: SqliteResourceNodeStateRaw | Record<string, unknown>,
): ResourceNodeStateRow {
  return {
    nodeId: String(raw.nodeId),
    quantityRemaining: Number(raw.quantityRemaining),
    respawnAt:
      raw.respawnAt === null || raw.respawnAt === undefined ? null : parseDate(raw.respawnAt),
    systemId: raw.systemId === null || raw.systemId === undefined ? null : String(raw.systemId),
  };
}

/** Map a raw system_registry row to the driver-agnostic shape. */
export function mapSystemRegistry(
  raw: SqliteSystemRegistryRaw | Record<string, unknown>,
): SystemRegistryRow {
  return {
    systemId: String(raw.systemId),
    name: String(raw.name),
    shardActive: Boolean(raw.shardActive),
    lastActiveAt: parseDate(raw.lastActiveAt),
  };
}

/** Raw shape of a `deposits` row straight from better-sqlite3 — TASK-37. */
export interface SqliteDepositRaw {
  id: string;
  systemId: string;
  planetId: string;
  pos: string;
  resourceId: string;
  remaining: number;
  discovered: number | boolean;
  depositSeq: number;
}

/** Map a raw deposits row to the driver-agnostic shape. */
export function mapDeposit(raw: SqliteDepositRaw | Record<string, unknown>): DepositStateRow {
  const posJson = parseJsonField(raw.pos, "pos") as { x?: number; y?: number; z?: number };
  return {
    id: String(raw.id),
    systemId: String(raw.systemId),
    planetId: String(raw.planetId),
    pos: { x: Number(posJson.x ?? 0), y: Number(posJson.y ?? 0), z: Number(posJson.z ?? 0) },
    resourceId: String(raw.resourceId),
    remaining: Number(raw.remaining),
    discovered: Boolean(raw.discovered),
    depositSeq: Number(raw.depositSeq),
  };
}
