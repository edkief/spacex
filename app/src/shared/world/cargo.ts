/**
 * Ship cargo hold model — TASK-39.
 *
 * The persistent storage on every player-owned ship. Distinct from
 * the player's on-foot inventory (TASK-34): the inventory rides on
 * the character, the cargo hold rides on the ship. The two move
 * independently — disembark leaves the cargo on the parked ship,
 * mining fills the inventory but not the hold, and the cargo
 * transfer flow (this task) moves stacks from inventory → hold at a
 * docked ship so the player can carry heavier loads between
 * locations.
 *
 * ## Shape (server-authoritative)
 *
 *   {
 *     stacks: { [resourceType]: amount },
 *     weightUsed: number,
 *     capacity: number,    // derived from the ship's class
 *   }
 *
 * `stacks` only carries entries with `amount > 0`; the loader
 * strips zero / negative rows so the persisted shape is dense.
 * `weightUsed` is recomputed from `stacks × weights` on every
 * mutation; the field exists so the wire and persistence layer
 * don't have to re-walk the stacks on every read.
 *
 * ## Capacity
 *
 * `capacity = shipClass.cargoSlots * 10` — the spec calls out
 * the scout at 40, interceptor at 20, freighter at 120. The
 * `cargoCapacityFor(...)` helper is the single source of truth so
 * a future stat rebalance only touches this file.
 *
 * The capacity math drives both the wire (`cargo_update.capacity`)
 * and the per-resource weight validation, so a class rebalance
 * ripples through every consumer automatically.
 *
 * ## Operations
 *
 *   `addToCargo`            — push into the hold; partial on overflow.
 *   `removeFromCargo`       — pull from the hold; rejects over-amount.
 *   `recomputeCargoWeight`  — derive `weightUsed` from `stacks`.
 *   `cargoCapacityFor`      — derive `capacity` from the ship class.
 *   `validateCargoHold`     — defensive validation for the loader.
 *
 * All operations are pure — no mutation, no I/O.
 *
 * @see ./inventory.ts for the on-foot inventory model.
 * @see ./cargoOps.ts for the pure-function operations.
 * @see ./ships.ts for the ship catalog (cargoSlots per class).
 */
import { z } from "zod";
import { SHIP_CLASSES, type ShipClassId } from "../ships.js";

// ---------------------------------------------------------------------------
// Constants — exported so the server can reuse them in error messages.
// ---------------------------------------------------------------------------

/**
 * The v1 cargo catalog — same resource types as the on-foot inventory
 * (TASK-34). A subset of the broader `ResourceType` union; future
 * liquids / gases would land here as specialised tank entries rather
 * than weight-stacked inventory rows.
 */
export const CARGO_RESOURCE_TYPES = ["iron", "copper", "rare-earths", "crystal"] as const;

/** Static type alias for the cargo catalog (subset of ResourceType). */
export type CargoResourceType = (typeof CARGO_RESOURCE_TYPES)[number];

/**
 * Per-unit weight contribution. Identical to the inventory catalog
 * (TASK-34 acceptance: "iron 1, copper 1, rare-earth 2, crystal 3")
 * so a transfer between backpack and hold doesn't change the
 * weight math at the unit level — only the cap does.
 */
export const CARGO_WEIGHT_PER_UNIT: Readonly<Record<CargoResourceType, number>> = {
  iron: 1,
  copper: 1,
  "rare-earths": 2,
  crystal: 3,
};

/** Set membership lookup so callers can validate resource ids cheaply. */
export const CARGO_RESOURCE_TYPE_SET: ReadonlySet<CargoResourceType> = new Set(
  CARGO_RESOURCE_TYPES,
);

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/**
 * Multiplier between `cargoSlots` and the weight capacity the hold
 * can carry. Spec value: each slot contributes 10 weight units.
 */
export const CARGO_WEIGHT_PER_SLOT = 10;

/**
 * Derive the cargo hold's weight capacity for a given ship class.
 * Pure function of `SHIP_CLASSES[classId].cargoSlots` so the class
 * catalog stays the single source of truth for both UI render
 * (TASK-51) and validation (this task).
 *
 * Throws when the id is unknown so the caller fails loudly instead
 * of silently defaulting to a meaningless capacity.
 */
export function cargoCapacityFor(classId: ShipClassId): number {
  const cls = SHIP_CLASSES[classId];
  if (!cls) {
    throw new Error(`cargoCapacityFor: unknown ship class id "${classId}"`);
  }
  return cls.cargoSlots * CARGO_WEIGHT_PER_SLOT;
}

/**
 * Narrow runtime check for inbound resource ids. Mirrors the
 * `isInventoryResourceType` pattern from TASK-34 so the cargo
 * transfer handler can branch on the same condition.
 */
export function isCargoResourceType(v: string): v is CargoResourceType {
  return (CARGO_RESOURCE_TYPE_SET as ReadonlySet<string>).has(v);
}

// ---------------------------------------------------------------------------
// Logical shape
// ---------------------------------------------------------------------------

/**
 * The persisted cargo hold shape. Server-authoritative — the client
 * never mutates it locally; the wire frame is `cargo_update`.
 *
 * `capacity` is denormalized on the wire so the HUD doesn't have to
 * know the player's ship class. On the server it's recomputed on
 * every read so a ship purchase (TASK-20) that bumps the class
 * widens the cap on the next broadcast.
 */
export interface CargoHold {
  /** Stack amounts keyed by resource id; absent entries = 0. */
  readonly stacks: Readonly<Partial<Record<CargoResourceType, number>>>;
  /** Total weight used, capped to `[0, capacity]`. */
  readonly weightUsed: number;
  /** Weight capacity (slots × 10). Per-class value. */
  readonly capacity: number;
}

/**
 * Empty cargo hold with no class-bound capacity. The capacity is
 * required on the wire so the HUD renders the right bar; callers
 * must set it explicitly via `cargoHoldFor(classId)`.
 */
export function emptyCargoHold(): Omit<CargoHold, "capacity"> {
  return { stacks: {}, weightUsed: 0 } as Omit<CargoHold, "capacity">;
}

/**
 * Build a fresh `CargoHold` for a given ship class. Used when
 * minting a starter ship and when a player purchases a new class
 * (the cargo resets because the ship itself is replaced).
 */
export function cargoHoldFor(classId: ShipClassId): CargoHold {
  return { stacks: {}, weightUsed: 0, capacity: cargoCapacityFor(classId) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Zod schema for the persisted cargo hold. Used by the persistence
 * layer when deserialising so a malformed row doesn't crash the
 * server boot — the loader replaces it with an empty hold rather
 * than the unsafe alternative of casting `unknown` to `CargoHold`.
 */
export const CargoHoldSchema = z
  .object({
    stacks: z.record(z.string(), z.number().int().nonnegative()),
    weightUsed: z.number().finite().nonnegative(),
    capacity: z.number().int().positive(),
  })
  .strict();
