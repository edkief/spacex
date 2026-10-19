/**
 * Hazard hydration — TASK-48.
 *
 * Wire the seed-derived `hazardsFor` result into the shard on
 * spawn. For storm / radzone cells the placer just records the
 * cell on `shard.hazardCells` so the per-tick `advanceHazards`
 * pass can apply exposure damage. For drone cells the placer
 * additionally mints one `kind: 'drone'` entity per drone
 * (`droneCount` is 2..4 in the seed), so the drones appear in
 * the entity_update broadcast on the very next tick.
 *
 * The hydrate is **fire-and-forget** (matches `deposit-hydrate.ts`
 * and `ai-hydrate.ts`): the router awaits `hydrateShardEntities`
 * for the critical player path, then calls `hydrateHazards`
 * without awaiting so the hazard entities land on the *next*
 * broadcast rather than blocking the spawn.
 *
 * Idempotent on `hazardId`: re-hydrating the same hazard list
 * yields the same cells + drones (the underlying
 * `registerHazardCells` is a no-op when an entry with the same
 * id already exists).
 *
 * @see ../../shared/world/hazards.ts for the seed placer.
 * @see ../shard/hazards.ts for the per-tick advance + drone
 *      lifecycle helpers.
 * @see ../shard/entity.ts for `makeDroneEntity` + the wire shape.
 * @see ./ai-hydrate.ts for the sibling fire-and-forget pattern.
 */

import { hazardsFor, type HazardCell } from "@shared/world/hazards.js";

import { padsForSystem } from "@shared/world/pads.js";
import { generateSystem } from "@shared/galaxy/system.js";
import { registerHazardCells } from "../shard/hazards.js";
import type { Shard } from "../shard/types.js";

/** Inputs to `hydrateHazards`. */
export interface HydrateHazardsOptions {
  /** Galaxy seed (same string the rest of the galaxy uses). */
  readonly seed: string;
  /** Optional wall-clock injection for the spawn timestamps. */
  readonly nowMs?: number;
}

/**
 * Walk the seed-derived hazard list and register every cell +
 * drone on the shard. Returns the cells that were registered so
 * the test suite + dev hook can render the population without a
 * second walk.
 */
export function hydrateHazards(
  shard: Shard,
  options: HydrateHazardsOptions,
): readonly HazardCell[] {
  // Re-derive the pad list so the placer has the safe-zone
  // input the production path uses. The pads are themselves
  // seed-derived (TASK-29), so this stays deterministic.
  const system = generateSystem(options.seed, shard.systemId);
  const pads = padsForSystem({
    seed: options.seed,
    starId: shard.systemId,
    planets: system.planets,
  });
  // Group pads by planet id so `hazardsFor` can read them as
  // the per-planet `padsByPlanet` map.
  const padsByPlanet = new Map<string, Array<{ pos: { x: number; y: number; z: number } }>>();
  for (const pad of pads) {
    const arr = padsByPlanet.get(pad.planetId) ?? [];
    arr.push({ pos: pad.pos });
    padsByPlanet.set(pad.planetId, arr);
  }
  const cells = hazardsFor({
    seed: options.seed,
    systemId: shard.systemId,
    padsByPlanet,
  });
  const now = options.nowMs ?? Date.now();
  registerHazardCells(shard, cells, { nowMs: now });
  return cells;
}
