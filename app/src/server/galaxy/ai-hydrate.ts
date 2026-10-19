/**
 * Rogue-AI roster hydration — TASK-45.
 *
 * Wire the seed-derived `rosterFor` result into the shard on
 * spawn. Each entry becomes one `kind: 'ai'` entity carrying:
 *
 *   - the deterministic `aiId` (hex id, `'ai:<hex>'`);
 *   - the class id, ship stats (spawn with class-full HP), and
 *     `cargo` (initial empty hold sized to the class);
 *   - the pirate callsign + `playerId: null`;
 *   - the `spawnPos` carried both as the entity's live `pos`
 *     (so the wire snapshot / sim tick see the rogue where it
 *     starts) AND as `aiSpawnPos` (so a later death knows where
 *     to remint from);
 *   - the `patrolCenter` + `patrolRadius` for TASK-46 to read
 *     when the AI state machine lands.
 *
 * The hydrate is **fire-and-forget** (matches `deposit-hydrate.ts`
 * pattern): the router awaits `hydrateShardEntities` for the
 * critical player path, then calls `hydrateAiRoster` without
 * awaiting so the AI ship entities land on the *next* broadcast
 * rather than blocking the spawn.
 *
 * Idempotent on entity id: re-hydrating the same roster yields
 * the same entities (the underlying `spawnAiShip` returns the
 * existing entity for a duplicate id). Calling hydrate after a
 * shard reap is the intended sequence \u2014 the apex re-spawn
 * re-derives the same roster and the call is a no-op when the
 * shards are identical.
 *
 * @see ../../shared/world/ai.ts for the seed placer.
 * @see ../shard/ai-respawn.ts for the respawn timer that this
 *      helper pairs with.
 */

import { rosterFor, type AIRosterEntry } from "@shared/world/ai.js";
import type { Planet } from "@shared/galaxy/types.js";
import { planetWorldPosition } from "@shared/regime-planets.js";
import type { Vec3 } from "@shared/physics/vec.js";
import type { Repository } from "../db/repo.js";
import { spawnAiShip } from "../shard/index.js";
import type { Shard } from "../shard/types.js";

/** Inputs to `hydrateAiRoster`. */
export interface HydrateAiRosterOptions {
  /** Galaxy seed used by `rosterFor`. Same string the rest of the
   *  galaxy uses \u2014 threaded by `loadAndRegister` from the router
   *  config. */
  readonly seed: string;
  /**
   * Per-planet world-position resolver. Defaults to
   * `planetWorldPosition(seed, starId, orbitIndex)` from
   * `@shared/regime-planets`. Tests inject a stub that returns
   * far-out positions so the placer's atmosphere-exclusion
   * rejection never fires.
   *
   * Returning a planet position resolves to the planet's
   * deterministic world centre, used to build the placer's
   * `AIRosterPlanet[].center` field for the no-atmosphere check.
   */
  readonly planetWorldPos?: (planet: Planet) => Vec3;
  /** Repository handle \u2014 reserved for future persistence. Today
   *  the roster is purely seed-derived (the DB never stores
   *  rogue ships) so the field is unused but threaded through
   *  so a future TASK-60 can extend without changing the
   *  hydrate path. */
  readonly repo?: Repository;
}

/**
 * Walk the seed-derived roster and mint one AI entity per
 * entry on the shard. Returns the entries that were minted
 * (useful for tests + the debug overlay's "show roster"
 * affordance).
 *
 * The placer takes the planet list from `shard.context.system`
 * and the pad list from `padsForSystem` so production wires
 * the exact same data the rest of the galaxy uses. The helper
 * is fire-and-forget so callers don't have to await it.
 */
export function hydrateAiRoster(
  shard: Shard,
  options: HydrateAiRosterOptions,
): readonly AIRosterEntry[] {
  const starId = shard.context.starId;
  const planetWorldPos =
    options.planetWorldPos ?? makeDefaultPlanetPositionResolver(options.seed, starId);
  const systemPlanets = shard.context.system.planets;
  // Translate the canonical `Planet` list into the placer's
  // atmosphere-rejection input shape (id, center, radiusKm,
  // hasAtmosphere). We resolve the planet world positions
  // lazily through the resolver so a future hot-reload of the
  // stellar layout flows through without a separate cache.
  const placerPlanets = systemPlanets.map((p) => ({
    id: p.id,
    center: planetWorldPos(p),
    radiusKm: p.radiusKm,
    hasAtmosphere: p.hasAtmosphere,
  }));
  // The placer also needs the per-pad positions to enforce
  // the 200 m station-separation rule. We re-derive them
  // through the shard's pad registry closure rather than
  // re-walking the planet list so a future TASK-29 change to
  // pad geometry propagates without touching this module.
  const placerStations = collectPlacerStations(shard);

  const roster = rosterFor({
    seed: options.seed,
    systemId: shard.systemId,
    stations: placerStations,
    planets: placerPlanets,
  });

  for (const entry of roster) {
    spawnAiShip(shard, {
      id: entry.aiId,
      classId: entry.classId,
      pos: entry.spawnPos,
      callsign: entry.callsign,
      aiSpawnPos: entry.spawnPos,
      aiPatrolCenter: entry.patrolCenter,
      aiPatrolRadius: entry.patrolRadius,
    });
  }

  return roster;
}

/**
 * Walk the shard's pad registry once and build the placer's
 * `AIRosterStation[]` shape. Defensive against a future shard
 * that ships without pads (e.g. a galaxy with no landable
 * planets) \u2014 the placer treats an empty station list as "no
 * rejection", which is the right default for a pad-free
 * system.
 */
function collectPlacerStations(shard: Shard): ReadonlyArray<{
  padId: string;
  planetId: string;
  pos: Vec3;
}> {
  // The shard doesn't expose pads directly; the surrounding
  // `system-data.ts` builder derived them once per shard.
  // We recover them by walking every planet and re-deriving
  // chunk (0, 0) \u2014 cheap because the planet list is bounded
  // (PLANET_COUNT_MAX = 6) and the surface generator is
  // cached.
  const planets = shard.context.system.planets;
  const out: Array<{ padId: string; planetId: string; pos: Vec3 }> = [];
  for (const planet of planets) {
    const pads = shard.context.padsForPlanet?.(planet.id);
    if (!pads) continue;
    for (const pad of pads) {
      out.push({
        padId: pad.id,
        planetId: planet.id,
        pos: { x: pad.x, y: 0, z: pad.z },
      });
    }
  }
  return out;
}

/**
 * Default `planetWorldPos` factory. Threads the `(seed, starId)`
 * pair into the deterministic resolver so every call site that
 * uses the default gets the same coordinate as
 * `@shared/regime-planets`.
 */
function makeDefaultPlanetPositionResolver(seed: string, starId: string) {
  return (planet: Planet): Vec3 => planetWorldPosition(seed, starId, planet.orbitIndex);
}
