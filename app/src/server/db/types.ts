/**
 * Shared domain types for the Drift persistence layer.
 *
 * These are the *logical* shapes used by the rest of the server — independent
 * of whether the underlying driver is SQLite or Postgres. The repository
 * (./repo.ts) is the only place that touches driver-specific types.
 *
 * Conventions inherited from PRD §8:
 *   - Geometry (stars/planets/terrain/node positions) is NEVER stored.
 *   - Only mutable state is persisted here.
 *   - `id` columns are strings holding RFC 4122 UUIDs (text under both drivers).
 *   - JSON columns (`livery`, `position`, `velocity`) are validated with zod at
 *     the repository boundary; persistence treats them as opaque JSON.
 */
import { z } from "zod";
import type { Inventory as SharedInventory } from "@shared/world/inventory.js";

/**
 * Ship hull classification per PRD §4.3 — only these three classes exist in
 * the catalog (TASK-19). Stored as TEXT in both drivers.
 */
export const SHIP_CLASS_IDS = ["scout", "freighter", "interceptor"] as const;
export type ShipClassId = (typeof SHIP_CLASS_IDS)[number];

/**
 * Ship lifecycle per PRD §8 — drives HUD/HUD-gated gameplay (egress requires
 * `docked`, combat applies while `flying`, etc.).
 */
export const SHIP_STATES = ["docked", "flying", "onfoot", "destroyed"] as const;
export type ShipState = (typeof SHIP_STATES)[number];

// V3 helper retained for future per-axis typed validators.
// (Currently inlined into position/velocity shapes so we can keep zod schemas
// flat and stable across driver changes.)
const _v3 = z.tuple([z.number(), z.number(), z.number()]);
void _v3;

/**
 * Ship position in world space (systemId + x/y/z light-seconds).
 * Persisted as JSON; the schema permits any object but the repository
 * rejects payloads that don't match this exact shape.
 */
export const ShipPositionSchema = z.object({
  systemId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export type ShipPosition = z.infer<typeof ShipPositionSchema>;

/**
 * Ship velocity (x/y/z light-seconds/second). Stored as JSON.
 */
export const ShipVelocitySchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export type ShipVelocity = z.infer<typeof ShipVelocitySchema>;

/**
 * Persistent ship livery customization (TASK-21).
 *
 * The canonical shape is intentionally minimal — colors only — so it
 * serializes deterministically across clients and persists across restarts.
 * A more elaborate scheme can extend this without changing the schema.
 */
export const ShipLiverySchema = z
  .object({
    primary: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
    secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
  })
  .strict();
export type ShipLivery = z.infer<typeof ShipLiverySchema>;

/** Logical shape of a row in the `players` table. */
export interface PlayerRow {
  id: string;
  callsign: string;
  credits: number;
  homeSystemId: string | null;
  /**
   * TASK-34: persistent on-foot inventory. Loaded alongside the row
   * so the in-memory play state always reflects the persisted truth.
   * The shape is exactly `Inventory` from `@shared/world/inventory`.
   */
  inventory: SharedInventory;
  createdAt: Date;
}

/** Logical shape of a row in the `ships` table. */
export interface ShipRow {
  id: string;
  ownerId: string;
  classId: ShipClassId;
  livery: ShipLivery;
  hull: number;
  shields: number;
  position: ShipPosition;
  velocity: ShipVelocity;
  state: ShipState;
  /**
   * Live orientation quaternion. Persisted as a JSON tuple of four
   * finite numbers. Defaults to `IDENTITY_QUATERNION` for pre-TASK-24
   * rows so a server restart preserves orientation continuity.
   */
  quat: ShipQuaternion;
  /** Current flight regime (TASK-25). Nullable for pre-TASK-24 rows. */
  regime: ShipRegime | null;
  /** Landing-pad id when `state === 'docked' | 'onfoot'`; null otherwise. */
  onPad: string | null;
  /** Wall-clock ms epoch when a wreck should be GC'd (TASK-23). */
  wreckExpiresAt: number | null;
  updatedAt: Date;
}

/**
 * Orientation quaternion persisted with the ship. The flight model
 * (`@shared/physics/vec`) uses the same shape internally; persisting
 * the four-tuple means a server restart resumes a ship mid-bank
 * with no visible snap (TASK-24 acceptance: "ship is within 1 u of
 * its last position").
 */
export const ShipQuaternionSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
export type ShipQuaternion = [number, number, number, number];

/** Canonical "facing +Z, level" quaternion used when none has been persisted yet. */
export const IDENTITY_QUATERNION: ShipQuaternion = [0, 0, 0, 1];

/**
 * Flight regime tag persisted with the ship (TASK-25). Nullable for
 * pre-TASK-24 rows so a backfill doesn't crash on the strict enum.
 */
export const ShipRegimeSchema = z.enum(["space", "atmosphere", "surface"]);
export type ShipRegime = z.infer<typeof ShipRegimeSchema>;

/** Logical shape of a row in the `cargo_items` table. */
export interface CargoItemRow {
  id: string;
  shipId: string;
  resourceType: string;
  quantity: number;
}

/** Logical shape of a row in the `sessions` table. */
export interface SessionRow {
  tokenHash: string;
  playerId: string;
  systemId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** Logical shape of a row in the `resource_node_state` table. */
export interface ResourceNodeStateRow {
  nodeId: string;
  quantityRemaining: number;
  respawnAt: Date | null;
  systemId: string | null;
}

/**
 * Logical shape of a row in the `deposits` table — TASK-37.
 *
 * `pos` is the world-space deposit position (JSON). The runtime
 * recomputes it from the seed on every read; the persisted value is
 * kept only for debugability + so a row write is a single snapshot of
 * the deposit's identity.
 *
 * `remaining` is the current stock (units). The seed-derived initial
 * amount is recovered from the placement; the row stores only the
 * delta so a restart resumes the same depletion state.
 *
 * `depositSeq` is the ordinal position of this deposit in the
 * system's deterministic placement list. Combined with `systemId`,
 * it's the primary key — see the `deposits` table definition.
 */
export interface DepositStateRow {
  id: string;
  systemId: string;
  planetId: string;
  pos: { x: number; y: number; z: number };
  resourceId: string;
  remaining: number;
  discovered: boolean;
  depositSeq: number;
}

/**
 * Inputs accepted by `upsertDepositState`. Carries every field so the
 * first write captures the deposit's identity (id, planet, pos,
 * resource). Subsequent writes carry only the mutable fields.
 */
export interface UpsertDepositStateInput {
  id: string;
  systemId: string;
  planetId: string;
  pos: { x: number; y: number; z: number };
  resourceId: string;
  remaining: number;
  discovered: boolean;
  depositSeq: number;
}

/** Logical shape of a row in the `system_registry` table. */
export interface SystemRegistryRow {
  systemId: string;
  name: string;
  shardActive: boolean;
  lastActiveAt: Date;
}

/** Inputs accepted by `createPlayer` (without server-generated fields). */
export interface CreatePlayerInput {
  callsign: string;
  homeSystemId: string;
}

/** Inputs accepted by `saveShipState` — only mutable fields. */
export interface SaveShipStateInput {
  hull?: number;
  shields?: number;
  position?: ShipPosition;
  velocity?: ShipVelocity;
  state?: ShipState;
  livery?: ShipLivery;
  /** Orientation quaternion (TASK-24). */
  quat?: ShipQuaternion;
  /** Flight regime (TASK-24). Pass null to clear. */
  regime?: ShipRegime | null;
  /** Landing-pad id; pass null to clear (TASK-24). */
  onPad?: string | null;
  /** Wreck TTL ms-epoch (TASK-23 + TASK-24). Pass null to clear. */
  wreckExpiresAt?: number | null;
}

/** Inputs accepted by `saveCargo` — fully replaces the ship's manifest. */
export interface CargoItemInput {
  resourceType: string;
  quantity: number;
}

/** Inputs accepted by `upsertNodeState`. */
export interface UpsertNodeStateInput {
  nodeId: string;
  systemId: string;
  quantityRemaining: number;
  respawnAt: Date | null;
}

/** Inputs accepted by `createSession`. */
export interface CreateSessionInput {
  tokenHash: string;
  playerId: string;
  systemId?: string | null;
  ttlMs: number;
}
