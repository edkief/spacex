/**
 * Dock sell contract (TASK-40) — the pure price math + atomic sell step
 * behind the terminal's Sell panel, the closing leg of the resource loop:
 * mine (inventory) → load (hold) → fly to dock → SELL here for credits.
 *
 * v1 pricing is the CATALOG BASE PRICE only — no per-station variation, no
 * market fluctuation (documented in the TASK-40 spec). RESOURCE_CATALOG is
 * the single place prices are read: this module's `sellUnitPrice` is the
 * ONE accessor, so a future market task changes one call site.
 *
 * The sell is the inverse of `transferCargo`'s source side: one resource
 * stack is decremented in exactly one place (the ship's hold or the
 * on-foot inventory) and `amount × basePrice` credits are granted — the
 * shard applies the returned NEW stacks + the repo's addCredits inside ONE
 * database transaction (atomicity: a failed credit write rolls the stack
 * decrement back, and vice versa).
 */

import { inventoryWeight, isResourceId, type InventoryStacks, type ResourceId } from './inventory';
import { RESOURCE_CATALOG } from './resources';
import type { CargoHold } from './cargo';

/**
 * The dock sell price (credits per unit) of one resource — the single
 * read site for the catalog's basePrice (TASK-40 AC: the endpoint is the
 * single place prices are read).
 * Accepts a raw string (NOT ResourceId) so the catalog boundary is enforced
 * HERE — the single place prices are read — and an unknown id is a thrown
 * error, not a silent 0.
 * @throws {Error} for a resource id that is not in the v1 catalog.
 */
export function sellUnitPrice(resourceId: string): number {
  if (!isResourceId(resourceId)) throw new Error(`unknown resource: ${resourceId}`);
  return RESOURCE_CATALOG[resourceId].basePrice;
}

/** The sellable sources: the ship's cargo hold or the on-foot inventory. */
export type SellSource = 'hold' | 'inv';

/**
 * The structured denial codes of the sell handler (the shard's handleSell
 * and the POST /api/ships/sell route share this vocabulary — the route maps
 * each code to its HTTP status).
 */
export type SellErrorCode =
  | 'unknown-ship'
  | 'invalid-resource'
  | 'invalid-amount'
  | 'not-docked'
  | 'not-at-station'
  | 'insufficient'
  | 'sell-failed';

export interface SellResult {
  /** The (NEW) cargo hold after the sell (unchanged reference for inv sells). */
  hold: CargoHold;
  /** The (NEW) inventory stacks after the sell (unchanged for hold sells). */
  inv: InventoryStacks;
  /** Units actually sold (always == the requested amount on success). */
  sold: number;
  /** Credits earned: sold × basePrice. */
  earned: number;
}

export type SellFailure =
  | { ok: false; code: 'invalid-resource'; resourceId: string }
  | { ok: false; code: 'invalid-amount'; amount: number }
  | { ok: false; code: 'insufficient'; resourceId: ResourceId; available: number }
  | ({ ok: true } & SellResult);

/**
 * Sell `amount` units of `resourceId` from ONE source, in one atomic step:
 * - `source: 'hold'` — the ship's cargo hold (in-ship selling requires the
 *   ship to be docked — the shard checks that, not this pure step);
 * - `source: 'inv'`  — the on-foot inventory (on-foot selling requires
 *   terminal proximity — also a shard check).
 * The request must be fully funded by the source (partial sells are NOT
 * the dock's job — the UI offers "Sell 1" / "Sell all", so a request can
 * never exceed what is sellable; a short request is an 'insufficient'
 * denial, mirroring the cargo transfer's moved-0 denial). Both stacks in
 * the result are NEW objects (never mutated); the caller applies them to
 * the entity + the DB (stack decrement + addCredits) in one commit. Pure.
 */
export function sellFrom(
  hold: CargoHold,
  inv: InventoryStacks,
  resourceId: string,
  amount: number,
  source: SellSource,
): SellFailure {
  if (!isResourceId(resourceId)) return { ok: false, code: 'invalid-resource', resourceId };
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, code: 'invalid-amount', amount };
  }
  const stacks = source === 'inv' ? inv : hold.stacks;
  const available = stacks[resourceId] ?? 0;
  if (amount > available) {
    return { ok: false, code: 'insufficient', resourceId, available };
  }
  const left = available - amount;
  const nextStacks: InventoryStacks = { ...stacks };
  if (left > 0) nextStacks[resourceId] = left;
  else delete nextStacks[resourceId];
  const earned = amount * sellUnitPrice(resourceId);
  // The hold's weightUsed is always RECOMPUTED from the new stacks (never
  // subtracted blind — the same discipline as toCargoHold).
  const nextHold: CargoHold =
    source === 'hold'
      ? { stacks: nextStacks, weightUsed: inventoryWeight(nextStacks), capacity: hold.capacity }
      : hold;
  const nextInv: InventoryStacks = source === 'inv' ? nextStacks : inv;
  return { ok: true, hold: nextHold, inv: nextInv, sold: amount, earned };
}

/**
 * The total sellable amount of one resource across BOTH sources (the dock
 * UI's "sellable amount, hold + on-foot inventory combined"). Pure.
 */
export function sellableTotal(
  hold: CargoHold,
  inv: InventoryStacks,
  resourceId: ResourceId,
): number {
  return (hold.stacks[resourceId] ?? 0) + (inv[resourceId] ?? 0);
}
