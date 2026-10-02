/**
 * Resource catalog (TASK-37) — the ONE definition of the v1 resource set's
 * economic + placement data, shared by the server (mining/dock, TASK-40)
 * and the client (ore-rock rendering colors).
 *
 * The per-unit WEIGHTS are the TASK-34-pinned inventory weights — they live
 * in @shared/inventory and this catalog must never diverge from them (the
 * unit test asserts identity). `basePrice` is the dock SELL price per unit
 * in credits (consumed by TASK-40). `spawnWeight` drives the seeded deposit
 * placement mix (TASK-37: iron 40 / copper 30 / rare-earth 20 / crystal 10).
 */

import { RESOURCE_IDS, RESOURCE_WEIGHTS, type ResourceId } from './inventory';
import type { Rng } from './random';

/** Catalog entry for one resource. */
export interface ResourceCatalogEntry {
  /** Weight per unit (MUST equal RESOURCE_WEIGHTS[resourceId]). */
  weight: number;
  /** Dock sell price per unit in credits (TASK-40). */
  basePrice: number;
  /** Spawn probability in seeded deposit placement (sums to 1). */
  spawnWeight: number;
  /** Ore-rock body color (client rendering, TASK-37 step 3). */
  color: string;
}

/**
 * The v1 catalog (AC-pinned prices): iron {1, 5}, copper {1, 8},
 * rare-earth {2, 25}, crystal {3, 60} credits per unit.
 */
export const RESOURCE_CATALOG: Record<ResourceId, ResourceCatalogEntry> = {
  iron: { weight: 1, basePrice: 5, spawnWeight: 0.4, color: '#8a8f98' },
  copper: { weight: 1, basePrice: 8, spawnWeight: 0.3, color: '#c47a3d' },
  'rare-earth': { weight: 2, basePrice: 25, spawnWeight: 0.2, color: '#3d6fd6' },
  crystal: { weight: 3, basePrice: 60, spawnWeight: 0.1, color: '#9b59d0' },
};

/** The catalog's resource ids, in catalog (RESOURCE_IDS) order. */
export const CATALOG_IDS: readonly ResourceId[] = RESOURCE_IDS;

/**
 * Weighted resource pick for deposit placement: a single uniform draw
 * against the catalog's cumulative spawn weights. Deterministic given the
 * Rng (same seed → same mix; the test asserts the 40/30/20/10 contract).
 */
export function pickResource(rng: Rng): ResourceId {
  let r = rng.nextF64();
  for (const id of RESOURCE_IDS) {
    r -= RESOURCE_CATALOG[id].spawnWeight;
    if (r < 0) return id;
  }
  return RESOURCE_IDS[RESOURCE_IDS.length - 1];
}
