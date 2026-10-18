/**
 * Resource catalog — TASK-37.
 *
 * The four v1 deposit resources plus their per-unit **weight** (used by
 * the on-foot inventory weight cap, TASK-34) and **basePrice** (used by
 * the dock sell route, TASK-40).
 *
 * The file lives at the top of the shared tree so both server (sell
 * math, deposit placement) and client (HUD colour table, prompt suffix)
 * pull from one source. The deposit-side resource type set is a narrow
 * subset of the broader `ResourceType` union declared in
 * `@shared/galaxy/types` — surface resource *fields* can carry fluid /
 * silicon etc., but deposits only spawn the four items a backpack can
 * carry.
 *
 * ## Selection weights
 *
 * `RESOURCE_WEIGHTS` controls the relative probability that a deposit
 * spawns each resource type. Iron 40 / copper 30 / rare-earth 20 /
 * crystal 10 — same numbers the spec calls out, with the sum pinned
 * to 1.0 by the test suite. The weights are a pure data table; the
 * `pickResource(rng)` helper does the rejection-sampled draw.
 *
 * ## Cross-compat with `@shared/world/inventory`
 *
 * The TASK-34 inventory already uses the string literals `iron`,
 * `copper`, `rare-earths`, `crystal` (note the trailing `s` on
 * rare-earths). To stay aligned with the wire shape and the existing
 * `isInventoryResourceType` guard the catalog keys use the same
 * literals. A future task can normalise the spelling if the project
 * ever wants to rename.
 */
import type { Rng } from "./random.js";

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * The four v1 deposit resources. Each row carries:
 *
 *   - `weight`: per-unit weight contribution to the on-foot inventory
 *     cap (`INVENTORY_WEIGHT_CAP = 40`). Iron/copper are 1, rare-earths
 *     2, crystal 3 — same numbers as the TASK-34 inventory.
 *   - `basePrice`: dock sell price per unit (TASK-40). The catalog row
 *     is the canonical price; sell maths must NOT redefine it.
 *
 * `id` is also the wire-shape string used by the `deposit` and
 * `groundItem` entities — see `@shared/protocol/schemas.ts`.
 */
export interface ResourceCatalogEntry {
  readonly id: ResourceId;
  /** Per-unit weight contribution. Matches TASK-34. */
  readonly weight: number;
  /** Dock sell price per unit (TASK-40). */
  readonly basePrice: number;
}

/** All deposit resource ids in display order (iron → crystal). */
export const RESOURCE_IDS = ["iron", "copper", "rare-earths", "crystal"] as const;

/** Static type for the resource id field on deposit entities. */
export type ResourceId = (typeof RESOURCE_IDS)[number];

/**
 * Set membership lookup so callers can validate resource ids cheaply.
 * Exported so the wire validator + the inventory handler can both
 * point at the same set without importing the tuple.
 */
export const RESOURCE_ID_SET: ReadonlySet<ResourceId> = new Set(RESOURCE_IDS);

/**
 * Resource catalog — the four v1 entries. Pinned by the test suite so
 * any future tweak forces an explicit refresh of the dependent code.
 */
export const RESOURCE_CATALOG: Readonly<Record<ResourceId, ResourceCatalogEntry>> = {
  iron: { id: "iron", weight: 1, basePrice: 5 },
  copper: { id: "copper", weight: 1, basePrice: 8 },
  "rare-earths": { id: "rare-earths", weight: 2, basePrice: 25 },
  crystal: { id: "crystal", weight: 3, basePrice: 60 },
};

// ---------------------------------------------------------------------------
// Selection weights (deposit spawn mix)
// ---------------------------------------------------------------------------

/**
 * Per-resource selection weight for deposit placement. The numbers
 * mirror the acceptance criteria: iron 40%, copper 30%, rare-earths
 * 20%, crystal 10%. Sum must equal 1.0 within float tolerance
 * (asserted by the test suite).
 */
export const RESOURCE_WEIGHTS: Readonly<Record<ResourceId, number>> = {
  iron: 0.4,
  copper: 0.3,
  "rare-earths": 0.2,
  crystal: 0.1,
};

/** Sum of weights — must equal 1.0 within float tolerance. */
export const RESOURCE_WEIGHT_SUM = Object.values(RESOURCE_WEIGHTS).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cheap validation of an arbitrary string against the catalog. Returns
 * the narrowed `ResourceId` when valid; `null` otherwise. Used by the
 * pickup validator and the wire schema guard.
 */
export function isResourceId(v: string): v is ResourceId {
  return (RESOURCE_ID_SET as ReadonlySet<string>).has(v);
}

/**
 * Look up the catalog row by id. Returns `undefined` for unknown ids;
 * callers should pre-validate with `isResourceId` and branch on the
 * narrowing return value.
 */
export function resourceEntry(id: ResourceId): ResourceCatalogEntry {
  return RESOURCE_CATALOG[id];
}

/** Per-unit weight contribution. Throws `RangeError` for unknown ids. */
export function resourceWeight(id: ResourceId): number {
  return RESOURCE_CATALOG[id].weight;
}

/** Dock sell price per unit. Throws `RangeError` for unknown ids. */
export function resourceBasePrice(id: ResourceId): number {
  return RESOURCE_CATALOG[id].basePrice;
}

/**
 * Seeded resource-type selection. Walks `RESOURCE_WEIGHTS` and picks
 * the first row whose cumulative weight exceeds the random draw.
 * Same algorithm as the planet-class selector in
 * `@shared/galaxy/planet.ts` so the test reader only has to learn
 * the pattern once.
 */
export function pickResource(rng: Rng): ResourceId {
  const u = rng.nextF64();
  let acc = 0;
  for (const id of RESOURCE_IDS) {
    acc += RESOURCE_WEIGHTS[id];
    if (u < acc) return id;
  }
  // Floating-point tail: last id wins.
  return RESOURCE_IDS[RESOURCE_IDS.length - 1];
}
