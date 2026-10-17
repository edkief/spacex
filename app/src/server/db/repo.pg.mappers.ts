/**
 * Row mappers for the Postgres repository.
 *
 * Postgres returns native `Date` objects for `timestamptz` columns and
 * `jsonb` payloads as already-parsed JS values. The only normalisation
 * needed is coercing raw rows into the driver-agnostic `*Row` types
 * defined in `./types.ts`.
 */
import {
  ShipLiverySchema,
  ShipPositionSchema,
  ShipVelocitySchema,
  type PlayerRow,
  type ResourceNodeStateRow,
  type SessionRow,
  type ShipClassId,
  type ShipRow,
  type SystemRegistryRow,
} from "./types.js";
import { parseDate } from "./repo.helpers.js";

/** Map a raw players row to the driver-agnostic shape. */
export function mapPlayer(raw: Record<string, unknown>): PlayerRow {
  return {
    id: String(raw.id),
    callsign: String(raw.callsign),
    credits: Number(raw.credits),
    homeSystemId:
      raw.homeSystemId === null || raw.homeSystemId === undefined ? null : String(raw.homeSystemId),
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
    updatedAt: parseDate(raw.updatedAt),
  };
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
