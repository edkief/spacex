/**
 * On-foot inventory model — TASK-34.
 *
 * The player's personal backpack while on foot: a weight-capped
 * carry capacity, stackable resource items, and the ability to drop
 * items at the character's location (for later pickup or for the
 * ship's cargo hold, TASK-39).
 *
 * ## Shape (server-authoritative)
 *
 *   {
 *     stacks: { [resourceType]: amount },
 *     weightUsed: number
 *   }
 *
 * `stacks` only contains entries with `amount > 0` — the loader
 * strips zero/negative rows so the persisted shape is dense.
 * `weightUsed` is a derivation of `stacks × weights`, kept on the
 * shape so the wire and the persistence layer don't have to
 * re-walk the stacks on every read.
 *
 * ## Capacity
 *
 * `INVENTORY_WEIGHT_CAP = 40` units of weight. Items contribute
 * weight per unit-amount:
 *
 *   - iron         : 1 u
 *   - copper       : 1 u
 *   - rare-earths  : 2 u
 *   - crystal      : 3 u
 *
 * 40 units ≈ 20 iron or ~13 crystal — tuned so a mining trip fills
 * the backpack and creates a reason to return to the ship (TASK-39).
 *
 * ## Operations
 *
 *   `addToInventory`     — pickup path (partial on overflow).
 *   `removeFromInventory` — drop path (rejects over-amount).
 *   `emptyInventory`     — clear (TASK-35 re-entry seam).
 *
 * All operations are pure — no mutation, no I/O. The server validates
 * every call against the player's authoritative copy and persists
 * afterwards (see `repo.saveInventory`).
 */
import type { ResourceType } from "../galaxy/types.js";

// ---------------------------------------------------------------------------
// Constants — exported so the server can reuse them in error messages.
// ---------------------------------------------------------------------------

/**
 * The v1 set of inventory resource types (TASK-34 catalog). A subset
 * of the broader `ResourceType` union used by the surface generator
 * (TASK-5); the on-foot backpack only tracks resources a player can
 * carry — fluids and gases (water, gas-compounds) are reserved for
 * the future ship-cargo flow (TASK-39) and arrive via specialised
 * tanks, not stacks.
 */
export const INVENTORY_RESOURCE_TYPES = ["iron", "copper", "rare-earths", "crystal"] as const;

/** Static type alias for the inventory catalog (subset of ResourceType). */
export type InventoryResourceType = (typeof INVENTORY_RESOURCE_TYPES)[number];

/**
 * Per-unit weight contribution (TASK-34 acceptance:
 * "iron 1, copper 1, rare-earth 2, crystal 3"). Total carry
 * capacity is `INVENTORY_WEIGHT_CAP = 40` units so the typical
 * load is "≈ 20 iron or ≈ 13 crystal".
 */
export const INVENTORY_WEIGHT_PER_UNIT: Readonly<Record<InventoryResourceType, number>> = {
  iron: 1,
  copper: 1,
  "rare-earths": 2,
  crystal: 3,
};

/** Total carry capacity, in weight units. Matches PRD §6. */
export const INVENTORY_WEIGHT_CAP = 40;

/** Set membership lookup so callers can validate resource ids cheaply. */
export const INVENTORY_RESOURCE_TYPE_SET: ReadonlySet<InventoryResourceType> = new Set(
  INVENTORY_RESOURCE_TYPES,
);

// ---------------------------------------------------------------------------
// Logical shape
// ---------------------------------------------------------------------------

/**
 * The persisted inventory shape. Server-authoritative — the client
 * never mutates it locally; the wire frame is `inventory_update`.
 */
export interface Inventory {
  /** Stack amounts keyed by resource id; absent entries = 0. */
  readonly stacks: Readonly<Partial<Record<InventoryResourceType, number>>>;
  /** Total weight used, capped to `[0, INVENTORY_WEIGHT_CAP]`. */
  readonly weightUsed: number;
}

/** zod-friendly typed factory — only the inventory types pass parsing. */
export const INVENTORY_RESOURCE_TYPE_VALUES =
  INVENTORY_RESOURCE_TYPES as ReadonlyArray<ResourceType>;

/**
 * Make a zod-friendly inventory validation helper. Exported separately
 * so callers (server + persistence) get a single source of truth
 * without importing `zod` here.
 */
export function isInventoryResourceType(v: string): v is InventoryResourceType {
  // `as readonly string[]` is the unsafe but pragmatic way to coerce
  // a readonly tuple back to a string iterable for `Set#has`.
  return (INVENTORY_RESOURCE_TYPE_SET as ReadonlySet<string>).has(v);
}
