/**
 * Inventory operations — pure functions that drive pickup / drop
 * math (TASK-34).
 *
 * Lives in its own module so the type catalogue (`inventory.ts`)
 * stays under the AGENTS.md line cap and so the operations can be
 * reused by tests + the server handler.
 *
 * ## Pure-function contract
 *
 *   - `addToInventory(inv, id, amount)` returns a NEW inventory
 *     shape — never mutates the input. Returns `{ taken, remaining }`
 *     where `taken + remaining === amount` and `taken` is bounded by
 *     remaining capacity.
 *   - `removeFromInventory(inv, id, amount)` validates ownership and
 *     returns a NEW inventory. Returns `{ taken, remaining }`; a
 *     non-zero `remaining` indicates the player tried to drop more
 *     than they owned (the caller should reject).
 *   - `emptyInventory()` returns an empty shape.
 *   - `validateInventory(inv)` is a debug-time sanity check the
 *     persistence layer calls when deserialising.
 */
import {
  INVENTORY_WEIGHT_CAP,
  INVENTORY_WEIGHT_PER_UNIT,
  type Inventory,
  type InventoryResourceType,
} from "./inventory.js";

/**
 * Empty inventory. Used by the server when minting a fresh player
 * and by tests as a neutral starting state.
 */
export function emptyInventory(): Inventory {
  return { stacks: {}, weightUsed: 0 };
}

/**
 * Look up the weight per unit for a resource id. Returns 0 for
 * unknown ids — callers should validate resource ids BEFORE invoking
 * this so 0 is defensive only.
 */
export function weightPerUnit(id: InventoryResourceType): number {
  return INVENTORY_WEIGHT_PER_UNIT[id];
}

/**
 * Recompute the total `weightUsed` for a given stack map. Used by
 * the persistence loader (TASK-34 acceptance: "weightUsed is derived
 * from stacks on load") and by tests that synthesise inventories.
 */
export function recomputeWeight(
  stacks: Readonly<Partial<Record<InventoryResourceType, number>>>,
): number {
  let total = 0;
  for (const id of Object.keys(stacks) as InventoryResourceType[]) {
    const amount = stacks[id] ?? 0;
    const perUnit = INVENTORY_WEIGHT_PER_UNIT[id];
    if (perUnit === undefined) continue; // defensive: unknown id
    total += amount * perUnit;
  }
  return total;
}

/** Clamp total weight to the carry cap (defensive). */
function clampWeight(weight: number): number {
  if (weight < 0) return 0;
  if (weight > INVENTORY_WEIGHT_CAP) return INVENTORY_WEIGHT_CAP;
  return weight;
}

/**
 * Add `amount` units of `id` to the inventory, respecting the
 * weight cap. Returns a new inventory + the `{taken, remaining}`
 * tuple. `taken + remaining === amount` always.
 *
 * Algorithm:
 *   1. Defensive: if amount <= 0 or id unknown, return the input
 *      inventory unchanged with `{taken: 0, remaining: amount}`.
 *   2. Capacity = (cap - weightUsed) / weightPerUnit. The player
 *      can carry at most that many units; remainder stays on the
 *      ground (the spec's "partial pickup at the boundary").
 *   3. New stack = existing + taken. We strip zero entries before
 *      returning so the persisted shape stays dense.
 */
export function addToInventory(
  inv: Inventory,
  id: InventoryResourceType,
  amount: number,
): { inventory: Inventory; taken: number; remaining: number } {
  if (amount <= 0 || !Number.isInteger(amount)) {
    return { inventory: inv, taken: 0, remaining: amount };
  }
  const perUnit = INVENTORY_WEIGHT_PER_UNIT[id];
  if (perUnit === undefined) {
    return { inventory: inv, taken: 0, remaining: amount };
  }
  const available = inv.weightUsed ?? 0;
  const capInUnits = Math.floor((INVENTORY_WEIGHT_CAP - available) / perUnit);
  if (capInUnits <= 0) {
    return { inventory: inv, taken: 0, remaining: amount };
  }
  const taken = Math.min(amount, capInUnits);
  const remaining = amount - taken;
  const existingAmount = inv.stacks[id] ?? 0;
  const nextStacks: Record<InventoryResourceType, number> = { ...inv.stacks } as Record<
    InventoryResourceType,
    number
  >;
  const newAmount = existingAmount + taken;
  if (newAmount <= 0) {
    delete nextStacks[id];
  } else {
    nextStacks[id] = newAmount;
  }
  const nextWeight = clampWeight((inv.weightUsed ?? 0) + taken * perUnit);
  return {
    inventory: { stacks: nextStacks, weightUsed: nextWeight },
    taken,
    remaining,
  };
}

/**
 * Remove `amount` units of `id` from the inventory. Returns a new
 * inventory + the `{taken, remaining}` tuple. If the inventory
 * doesn't hold `amount` of `id`, `taken` is capped at what's
 * available and `remaining` is non-zero — the caller MUST reject the
 * drop in that case.
 *
 * The shipped amount can be zero (one-shot empty drop) — `inv.stacks`
 * is the source of truth for "how much is left".
 */
export function removeFromInventory(
  inv: Inventory,
  id: InventoryResourceType,
  amount: number,
): { inventory: Inventory; taken: number; remaining: number } {
  if (amount <= 0 || !Number.isInteger(amount)) {
    return { inventory: inv, taken: 0, remaining: amount };
  }
  const perUnit = INVENTORY_WEIGHT_PER_UNIT[id];
  if (perUnit === undefined) {
    return { inventory: inv, taken: 0, remaining: amount };
  }
  const owned = inv.stacks[id] ?? 0;
  const taken = Math.min(amount, owned);
  const remaining = amount - taken;
  if (taken <= 0) {
    return { inventory: inv, taken: 0, remaining };
  }
  const nextStacks: Record<InventoryResourceType, number> = { ...inv.stacks } as Record<
    InventoryResourceType,
    number
  >;
  const newAmount = owned - taken;
  if (newAmount <= 0) {
    delete nextStacks[id];
  } else {
    nextStacks[id] = newAmount;
  }
  const nextWeight = clampWeight((inv.weightUsed ?? 0) - taken * perUnit);
  return {
    inventory: { stacks: nextStacks, weightUsed: nextWeight },
    taken,
    remaining,
  };
}

/**
 * Defensive validator used by the persistence layer when deserialising.
 * Returns `null` for malformed shapes; the caller should treat that as
 * "discard the persisted row + start fresh" rather than crash.
 */
export function validateInventory(value: unknown): value is Inventory {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { stacks?: unknown; weightUsed?: unknown };
  if (typeof v.weightUsed !== "number" || !Number.isFinite(v.weightUsed)) return false;
  if (v.weightUsed < 0 || v.weightUsed > INVENTORY_WEIGHT_CAP) return false;
  if (typeof v.stacks !== "object" || v.stacks === null) return false;
  const s = v.stacks as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!(key in INVENTORY_WEIGHT_PER_UNIT)) return false;
    const amt = s[key];
    if (typeof amt !== "number" || !Number.isInteger(amt) || amt < 0) return false;
  }
  // Verify the persisted weight agrees with the derived weight — a
  // mismatch means a corrupt row and the loader should reject it.
  if (v.weightUsed !== recomputeWeight(s as Partial<Record<InventoryResourceType, number>>)) {
    return false;
  }
  return true;
}
