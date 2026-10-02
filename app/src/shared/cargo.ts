/**
 * Ship cargo-hold contract (TASK-39) — the pure capacity math + atomic
 * transfer behind the ship's hold, the "haul leg" of the resource loop:
 * mine (inventory) → load (hold) → fly to dock → sell (hold, TASK-40).
 *
 * The hold is ON THE SHIP (not the player): it persists with the ship row
 * (ships.cargo JSON — the same parse/sanitize discipline as
 * players.inventory), survives restarts, and travels with the ship across
 * warp.
 *
 * Capacity is derived from ONE class stat — `cargoSlots` (TASK-19):
 * capacity = cargoSlots × 10 weight units (scout 4×10=40, interceptor
 * 2×10=20, freighter 12×10=120). There is no second source of truth: the
 * freighter's 120 is the economic differentiator (~3 scout trips per
 * freighter trip — the reason to buy it).
 */

import {
  INVENTORY_MAX_WEIGHT,
  RESOURCE_WEIGHTS,
  inventoryWeight,
  isResourceId,
  sanitizeInventory,
  type InventoryStacks,
  type ResourceId,
} from './inventory';
import { shipStats } from './ships';

/** Weight units per cargo slot — the single factor turning slots into capacity. */
export const CARGO_SLOT_WEIGHT = 10;

/**
 * The cargo capacity (weight units) of one ship class:
 * cargoSlots × 10 (scout 40, interceptor 20, freighter 120).
 * @throws {UnknownShipClassError} for any id that is not a v1 class.
 */
export function cargoCapacityFor(classId: string): number {
  return shipStats(classId).cargoSlots * CARGO_SLOT_WEIGHT;
}

/** The full cargo-hold state (wire + entity shape). */
export interface CargoHold {
  /** Stacks of resource units (same sparse shape as the inventory). */
  stacks: InventoryStacks;
  /** Recomputed from stacks — never stored blind. */
  weightUsed: number;
  /** class.cargoSlots × 10 (see cargoCapacityFor). */
  capacity: number;
}

/** An empty hold for a class (a fresh ship's starting state). */
export function emptyCargoHold(classId: string): CargoHold {
  const capacity = cargoCapacityFor(classId);
  return { stacks: {}, weightUsed: 0, capacity };
}

/** Weight units still free in the hold (≥ 0; 0 at/over the cap). */
export function cargoWeightRemaining(hold: CargoHold): number {
  return Math.max(0, hold.capacity - hold.weightUsed);
}

/** Rebuild the hold state from stacks (weight recomputed, capacity from class). */
export function toCargoHold(stacks: InventoryStacks, classId: string): CargoHold {
  const capacity = cargoCapacityFor(classId);
  return { stacks, weightUsed: inventoryWeight(stacks), capacity };
}

/**
 * Sanitize a raw persisted cargo value (ships.cargo JSON): keep only known
 * resource ids with finite integer amounts ≥ 0, drop zero amounts. Corrupt
 * rows can never wedge a shard (TASK-24 precedent).
 */
export function sanitizeCargo(raw: unknown): InventoryStacks {
  return sanitizeInventory(raw);
}

/**
 * Parse the raw ships.cargo JSON string into sanitized stacks (empty string
 * / corrupt JSON / non-object → {}). The one definition for the read sites
 * (the shard's entityFromShipRow + any future reader).
 */
export function parseCargoJson(raw: string | null | undefined): InventoryStacks {
  if (typeof raw !== 'string' || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // corrupt row: treat as empty
  }
  return sanitizeCargo(parsed);
}

export interface CargoTransferResult {
  /** The (NEW) cargo hold after the transfer. */
  hold: CargoHold;
  /** The (NEW) inventory stacks after the transfer. */
  inv: InventoryStacks;
  /** Units actually moved (may be < requested: partial at the boundary). */
  moved: number;
  /** Units not moved (requested - moved, ≥ 0) — stay where they started. */
  remaining: number;
}

/**
 * Move up to `amount` units of `resourceId` between the on-foot inventory
 * and the ship's cargo hold, in one atomic step:
 * - `from: 'inv'`  — LOAD: inventory → hold, bounded by what is owned AND
 *   the hold's remaining weight (a full hold takes 0; near the cap, exactly
 *   enough fits — the "partial when hold nears cap" AC);
 * - `from: 'hold'` — UNLOAD: hold → inventory, bounded by what is stowed
 *   AND the inventory's remaining weight (the 40 u cap).
 * Both stacks in the result are NEW objects (never mutated); the caller
 * applies them to the entity + persistence in one step. Pure.
 */
export function transferCargo(
  hold: CargoHold,
  inv: InventoryStacks,
  resourceId: ResourceId,
  amount: number,
  from: 'inv' | 'hold',
): CargoTransferResult {
  if (amount <= 0) return { hold, inv, moved: 0, remaining: 0 };
  const perUnit = RESOURCE_WEIGHTS[resourceId];
  const source = from === 'inv' ? inv : hold.stacks;
  const destStacks = from === 'inv' ? hold.stacks : inv;
  const destCap = from === 'inv' ? hold.capacity : INVENTORY_MAX_WEIGHT;
  const owned = source[resourceId] ?? 0;
  const room = Math.max(0, destCap - inventoryWeight(destStacks));
  const moved = Math.min(amount, owned, Math.floor(room / perUnit));
  if (moved === 0) return { hold, inv, moved: 0, remaining: amount };
  const sourceLeft = { ...source };
  const left = owned - moved;
  if (left > 0) sourceLeft[resourceId] = left;
  else delete sourceLeft[resourceId];
  const destNext: InventoryStacks = {
    ...destStacks,
    [resourceId]: (destStacks[resourceId] ?? 0) + moved,
  };
  const nextHold: CargoHold =
    from === 'inv'
      ? { stacks: destNext, weightUsed: inventoryWeight(destNext), capacity: hold.capacity }
      : { stacks: sourceLeft, weightUsed: inventoryWeight(sourceLeft), capacity: hold.capacity };
  return {
    hold: nextHold,
    inv: from === 'inv' ? sourceLeft : destNext,
    moved,
    remaining: amount - moved,
  };
}
