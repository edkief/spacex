/**
 * Player inventory contract (TASK-34) — the pure weight math behind the
 * server-authoritative on-foot inventory.
 *
 * One inventory per player (shared across ship and on-foot; the ship's
 * cargo hold is separate — TASK-39). Items are STACKS of resource types;
 * the cap is WEIGHT (40 units), not slots or item counts.
 *
 * The catalog below is the v1 set with the TASK-34-pinned per-unit weights
 * (iron 1, copper 1, rare-earth 2, crystal 3 ≈ 20 iron or ~13 crystal).
 * TASK-37's seeded node catalog reuses these ids + weights (it adds node
 * placement/depletion, not a second weight table).
 */

/** The v1 resource ids (stable strings — they persist in players.inventory). */
export const RESOURCE_IDS = ['iron', 'copper', 'rare-earth', 'crystal'] as const;
export type ResourceId = (typeof RESOURCE_IDS)[number];

export function isResourceId(value: string): value is ResourceId {
  return (RESOURCE_IDS as readonly string[]).includes(value);
}

/** Per-unit weight (units per unit-amount). TASK-34-pinned. */
export const RESOURCE_WEIGHTS: Record<ResourceId, number> = {
  iron: 1,
  copper: 1,
  'rare-earth': 2,
  crystal: 3,
};

/** The weight cap: one inventory holds at most 40 weight units. */
export const INVENTORY_MAX_WEIGHT = 40;

/** An inventory's contents: stacks of resource units (0 omitted/sanitized). */
export type InventoryStacks = Partial<Record<ResourceId, number>>;

/** One stack of resource units. */
export interface InventoryStack {
  resourceId: ResourceId;
  amount: number;
}

/** The full inventory state (wire + persistence shape). */
export interface PlayerInventory {
  stacks: InventoryStacks;
  weightUsed: number;
}

/** Weight of one stack (0 for an unknown resource — defensive, not an error). */
export function stackWeight(resourceId: ResourceId, amount: number): number {
  return (RESOURCE_WEIGHTS[resourceId] ?? 0) * amount;
}

/** Total weight used by the stacks (unknown ids / zero amounts count 0). */
export function inventoryWeight(stacks: InventoryStacks): number {
  let total = 0;
  for (const [id, amount] of Object.entries(stacks)) {
    if (isResourceId(id) && amount > 0) total += stackWeight(id, amount);
  }
  return total;
}

/** Weight capacity left (≥ 0; 0 at/over the cap). */
export function weightRemaining(stacks: InventoryStacks): number {
  return Math.max(0, INVENTORY_MAX_WEIGHT - inventoryWeight(stacks));
}

/** The stacks as a deterministic list (catalog order, 0-amounts dropped). */
export function listStacks(stacks: InventoryStacks): InventoryStack[] {
  return RESOURCE_IDS.map((resourceId) => ({
    resourceId,
    amount: stacks[resourceId] ?? 0,
  })).filter((s) => s.amount > 0);
}

export interface PickupResult {
  /** The (NEW) stacks after the pickup. */
  stacks: InventoryStacks;
  /** Units actually taken (may be < requested: partial at the boundary). */
  taken: number;
  /** Units left on the deposit/ground (requested - taken, ≥ 0). */
  remaining: number;
}

/**
 * Partial pickup (AC: "take what fits, remainder stays on the
 * deposit/ground"): add up to `amount` units of `resourceId`, bounded by
 * the weight cap. At the boundary exactly enough fits (e.g. 39/40 iron,
 * take 5 → taken 1, remaining 4). A full inventory takes 0. Pure.
 */
export function pickupInto(
  stacks: InventoryStacks,
  resourceId: ResourceId,
  amount: number,
): PickupResult {
  if (amount <= 0) return { stacks, taken: 0, remaining: 0 };
  const perUnit = RESOURCE_WEIGHTS[resourceId];
  const room = weightRemaining(stacks);
  const taken = Math.max(0, Math.min(amount, Math.floor(room / perUnit)));
  if (taken === 0) return { stacks, taken: 0, remaining: amount };
  return {
    stacks: { ...stacks, [resourceId]: (stacks[resourceId] ?? 0) + taken },
    taken,
    remaining: amount - taken,
  };
}

export interface DropResult {
  /** The (NEW) stacks after the drop. */
  stacks: InventoryStacks;
  /** Units actually dropped (may be < requested: only what is owned). */
  dropped: number;
  /** Units still in the inventory (requested - dropped, ≥ 0). */
  remaining: number;
}

/**
 * Drop `amount` units of `resourceId` from the stacks, bounded by what is
 * owned (0 owned → dropped 0). Zero-amount stacks are removed from the
 * result (the persisted shape stays sparse). Pure.
 */
export function dropFrom(stacks: InventoryStacks, resourceId: ResourceId, amount: number): DropResult {
  if (amount <= 0) return { stacks, dropped: 0, remaining: 0 };
  const owned = stacks[resourceId] ?? 0;
  const dropped = Math.min(owned, amount);
  if (dropped === 0) return { stacks, dropped: 0, remaining: amount };
  const left = owned - dropped;
  const next = { ...stacks };
  if (left > 0) next[resourceId] = left;
  else delete next[resourceId];
  return { stacks: next, dropped, remaining: amount - dropped };
}

/**
 * Sanitize a loaded/persisted inventory (players.inventory JSON): keep only
 * known resource ids with finite integer amounts ≥ 0, drop zero amounts.
 * Corrupt rows can never wedge a shard (TASK-24 precedent).
 */
export function sanitizeInventory(raw: unknown): InventoryStacks {
  const out: InventoryStacks = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isResourceId(id)) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) continue;
    if (value > 0) out[id] = value;
  }
  return out;
}

/** The wire/persistence shape of an inventory (weight recomputed, never stored blind). */
export function toPlayerInventory(stacks: InventoryStacks): PlayerInventory {
  return { stacks, weightUsed: inventoryWeight(stacks) };
}

/** Empty inventory (a new player's starting state). */
export function emptyInventory(): InventoryStacks {
  return {};
}
