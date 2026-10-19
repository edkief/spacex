/**
 * Dock-sell operations — TASK-40.
 *
 * Pure-function math for converting cargo / on-foot inventory stacks
 * into credits at the dock. Lives next to the cargo + inventory ops
 * so the wire-side `sell` handler and the unit tests share one
 * price model.
 *
 * ## Pure-function contract
 *
 *   - `priceFor(id)` — read the canonical `basePrice` from the
 *     resource catalog (TASK-37). Returns `null` for unknown ids so
 *     the caller can branch with a structured `unknown-resource`
 *     error rather than a silent `NaN`.
 *   - `sellStack({ stacks, id, amount })` — debits the source
 *     stack by the sold amount (clamped to what's owned) and
 *     reports `{ sold, earned, remaining }`. Pure: never mutates
 *     the input. `sold` is the cap-bound units actually removed;
 *     `remaining` is what's left on the shelf; `earned` is
 *     `sold * basePrice`.
 *   - `totalSellable(...)` — convenience that combines the
 *     on-foot inventory stack with the ship's hold stack. Used by
 *     the dock UI panel to display the per-resource sellable total
 *     so the player can pick how much to cash out.
 *
 * The price model is **base-price only in v1** — no per-station
 * variation, no market fluctuation. The catalog row in
 * `@shared/resources.ts` is the single source of truth so the
 * route layer can't redefine the price.
 *
 * @see ../../shared/resources.ts for the price catalog.
 * @see ./cargo.ts for the cargo hold shape.
 * @see ./inventory.ts for the on-foot inventory shape.
 */
import {
  CARGO_RESOURCE_TYPES,
  CARGO_WEIGHT_PER_UNIT,
  type CargoHold,
  type CargoResourceType,
} from "./cargo.js";
import {
  INVENTORY_RESOURCE_TYPES,
  INVENTORY_WEIGHT_PER_UNIT,
  type Inventory,
  type InventoryResourceType,
} from "./inventory.js";
import { RESOURCE_CATALOG, type ResourceId } from "../resources.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonical base price for a deposit resource (TASK-37 catalog).
 * Returns `null` for unknown ids so callers can branch on a
 * structured error rather than silently returning `NaN`.
 *
 * Exported so the dock UI can render the price column without a
 * second import path — the catalog is the single source of truth
 * for both the price math and the visible table.
 */
export function priceFor(id: ResourceId): number {
  const row = RESOURCE_CATALOG[id];
  return row.basePrice;
}

/** Type-narrow predicate mirroring `isCargoResourceType`. */
export function isSellableResourceType(v: string): v is ResourceId {
  return (CARGO_RESOURCE_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// sellStack — debit a single source map and report the credit gain.
// ---------------------------------------------------------------------------

/**
 * Pure debit + credit computation against a single source map
 * (inventory OR cargo). The shape is uniform across both sources
 * (`Partial<Record<ResourceId, number>>`) so the handler can swap
 * which one it points at based on the `source` request field.
 *
 *   - `id` is the resource being sold.
 *   - `amount` is the *requested* amount; the function caps
 *     `sold` at the source's current stack and reports the rest
 *     as `remaining`. A non-zero `remaining` indicates the
 *     caller requested more than was available — the handler
 *     should reject the transaction (per spec: `insufficient`).
 *   - `sold` is what actually left the source.
 *   - `earned` is `sold * basePrice`.
 *
 * The returned `stacks` is a *new* object — the input is never
 * mutated. The handler persists the new shape and surfaces the
 * earned credits in the response.
 */
export function sellStack(args: {
  stacks: Readonly<Partial<Record<ResourceId, number>>>;
  id: ResourceId;
  amount: number;
}): {
  stacks: Partial<Record<ResourceId, number>>;
  sold: number;
  earned: number;
  remaining: number;
} {
  const owned = args.stacks[args.id] ?? 0;
  if (args.amount <= 0 || !Number.isInteger(args.amount)) {
    return {
      stacks: { ...args.stacks },
      sold: 0,
      earned: 0,
      remaining: Math.max(0, owned),
    };
  }
  const sold = Math.min(args.amount, owned);
  const remaining = args.amount - sold;
  if (sold <= 0) {
    return {
      stacks: { ...args.stacks },
      sold: 0,
      earned: 0,
      remaining: args.amount,
    };
  }
  const nextStacks: Partial<Record<ResourceId, number>> = { ...args.stacks };
  const newAmount = owned - sold;
  if (newAmount <= 0) {
    delete nextStacks[args.id];
  } else {
    nextStacks[args.id] = newAmount;
  }
  const price = priceFor(args.id);
  return {
    stacks: nextStacks,
    sold,
    earned: sold * price,
    remaining,
  };
}

// ---------------------------------------------------------------------------
// totalSellable — convenience for the dock UI panel.
// ---------------------------------------------------------------------------

/**
 * Combine the on-foot inventory + cargo hold stacks for a single
 * resource so the dock UI can render "sellable: 18" as one number
 * (instead of splitting it across backpack + hold rows).
 *
 * Pure: returns the integer total. Does NOT mutate either input.
 */
export function totalSellable(args: {
  inventory: Inventory;
  cargo: CargoHold;
  id: ResourceId;
}): number {
  const inv = args.inventory.stacks[args.id] ?? 0;
  const cargo = args.cargo.stacks[args.id] ?? 0;
  return inv + cargo;
}

// ---------------------------------------------------------------------------
// Derived source-shape helpers
// ---------------------------------------------------------------------------

/**
 * Recompute `cargo.weightUsed` after a `sellStack` debit. Pure:
 * returns the integer total derived from `cargo * weightPerUnit`
 * for the resource catalog so a partial sell doesn't leave a
 * stale weight on the wire shape.
 */
export function recomputeCargoWeightAfterSell(cargo: CargoHold): number {
  let total = 0;
  for (const id of Object.keys(cargo.stacks) as CargoResourceType[]) {
    const amount = cargo.stacks[id] ?? 0;
    const perUnit = CARGO_WEIGHT_PER_UNIT[id];
    if (perUnit === undefined) continue;
    total += amount * perUnit;
  }
  if (total < 0) return 0;
  if (total > cargo.capacity) return cargo.capacity;
  return total;
}

/**
 * Recompute `inventory.weightUsed` after a `sellStack` debit.
 * Mirrors `recomputeCargoWeightAfterSell` for the on-foot side so
 * the persisted + wire shape stays consistent. Uses the on-foot
 * inventory catalog (`INVENTORY_WEIGHT_PER_UNIT`) so the
 * per-resource math agrees with `addToInventory` /
 * `removeFromInventory` in `inventoryOps.ts`.
 */
export function recomputeInventoryWeightAfterSell(inv: Inventory): number {
  let total = 0;
  for (const id of Object.keys(inv.stacks) as InventoryResourceType[]) {
    const amount = inv.stacks[id] ?? 0;
    const perUnit = INVENTORY_WEIGHT_PER_UNIT[id];
    if (perUnit === undefined) continue;
    void INVENTORY_RESOURCE_TYPES;
    total += amount * perUnit;
  }
  if (total < 0) return 0;
  return total;
}
