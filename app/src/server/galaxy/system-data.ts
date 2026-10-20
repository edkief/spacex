/**
 * Build the deterministic `ShardSystemContext` for a system on demand
 * (TASK-11 router).
 *
 * The router needs to mint a `Shard` for a system the first time a
 * player joins it. To do that it has to:
 *   1. Resolve the parent `Star` so the `ShardSystemContext.system`
 *      field is non-empty. The chart and the chat UI both want the
 *      star's class + name; the router gets the star from
 *      `generateStars(seed, count)` and indexes by id.
 *   2. Generate the full `SystemGen` via `generateSystem(seed, star)`
 *      so the system gets a deterministic planet list.
 *   3. Build the `planetById` + `heightAtFor` lookup closures. The
 *      `heightAtFor` closure returns `() => 0` for v1 — surface chunk
 *      generation lives in TASK-26 (streaming pipeline); the router
 *      only needs the *shape* of the lookup wired so future tasks can
 *      swap in real per-planet terrain resolution.
 *   4. TASK-29: derive the per-planet landing-pad list (cached on
 *      first call) so the in-tick pad detection can mark a ship
 *      `docked` when it crosses the 20 m threshold.
 *
 * The function is pure (seed + starId in, context out). Tests can
 * assert determinism by calling it twice with the same inputs.
 *
 * @see ./router.ts for the consumer.
 * @see ../../shared/galaxy/system.ts for the upstream generator.
 */
import { generateStars } from "@shared/galaxy/stars.js";
import { generateSystem } from "@shared/galaxy/system.js";
import { padsForSystem, type SystemPad } from "@shared/world/pads.js";
import type { FlightPad } from "@shared/physics/types.js";

import type { Planet, Star, SystemGen } from "@shared/galaxy/types.js";
import type { ShardSystemContext } from "../shard/types.js";

/** Options bag for `buildShardContext`. */
export interface BuildShardContextOptions {
  /** Galaxy seed (TASK-3 / PRD §6). */
  seed: string;
  /** Number of stars in the deterministic galaxy. Indexes through `generateStars`. */
  starCount: number;
  /** System id (= star id for v1). Looked up in the star chart. */
  systemId: string;
}

/**
 * Resolve the `ShardSystemContext` for a freshly-loaded system.
 *
 * Throws if the requested `systemId` is not in the seeded galaxy. The
 * router catches the error and maps it to a structured `system-not-found`
 * error response so the client can pick a different target.
 *
 * The `heightAtFor` closure returns a placeholder (`() => 0`) for v1.
 * Future TASK-26 will swap this in with the per-planet terrain cache.
 */
export function buildShardContext(options: BuildShardContextOptions): ShardSystemContext {
  const { seed, starCount, systemId } = options;
  const star = findStar(seed, starCount, systemId);
  if (!star) {
    throw new GalaxySystemNotFoundError(systemId);
  }
  const system: SystemGen = generateSystem(seed, star);

  const planetByIdMap = new Map<string, Planet>();
  for (const planet of system.planets) {
    planetByIdMap.set(planet.id, planet);
  }

  // v1 placeholder: surface chunk streaming (TASK-26) will replace this
  // with a 3×3 neighbourhood cache keyed by `(planetId, chunkX, chunkZ)`.
  // The seal is here so calling code can rely on the function being
  // defined without an `undefined` branch.
  const heightAtFor = (_planetId: string): ((_x: number, _z: number) => number) | undefined => {
    return (_x: number, _z: number) => 0;
  };

  // TASK-29: derive the pad registry once per system (cached on the
  // closure below) and expose the per-planet view that the
  // integrator's `PlanetAtmosphere.pads` reads. The translation
  // `SystemPad -> FlightPad` passes the world-space position so
  // the integrator can match against `entity.pos` (which is
  // already in world coords from `spawnShip`).
  const systemPads: SystemPad[] = padsForSystem({
    seed,
    starId: star.id,
    planets: system.planets,
  });
  const padsByPlanet = new Map<string, SystemPad>();
  for (const pad of systemPads) {
    padsByPlanet.set(pad.planetId, pad);
  }
  const padsForPlanet = (planetId: string): readonly FlightPad[] | undefined => {
    const pad = padsByPlanet.get(planetId);
    if (!pad) return undefined;
    // Pad in world coords. The integrator's `findNearestPad` reads
    // `pos.x / pos.z` against `pad.x / pad.z` (no planet-local
    // transform) because the `PlanetAtmosphere.heightAt` callback
    // already works in world coords — see
    // `regimeFor` → `distanceToSurface` for the same convention.
    return [
      {
        id: pad.padId,
        x: pad.pos.x,
        z: pad.pos.z,
        // Pad sits on the surface (TASK-29 step 1: "top of the
        // structure, flat 40 m circle"). `height` is the metres
        // above the planet's radius — 0 for surface-level pads.
        height: 0,
        radius: pad.radius,
        exitRadius: pad.exitRadius,
      },
    ];
  };

  return {
    system,
    starId: star.id,
    planetById: (planetId: string) => planetByIdMap.get(planetId),
    heightAtFor,
    tileSizeM: 64,
    // TASK-25: forward the galaxy seed so the regime manager can
    // place each planet in world space (deterministic from the
    // seed + star id). Callers that don't know the seed leave
    // this undefined; the sim falls back to the dev seed.
    galaxySeed: seed,
    // TASK-29: pad registry for in-tick dock detection.
    padsForPlanet,
    // TASK-49: the same pad list in world space, exposed as a flat
    // accessor so the destruction handler can pick the nearest
    // dock by 3D distance without re-walking the planets.
    padsForSystem: () => systemPads,
  };
}

/**
 * Look up the parent `Star` for a given system id in the seeded galaxy.
 * `systemId` is the same value used as `Star.id` (TASK-3 + TASK-4
 * keep them identical so the chart UI doesn't need a join).
 */
export function findStar(seed: string, starCount: number, systemId: string): Star | undefined {
  const stars = generateStars(seed, starCount);
  return stars.find((s) => s.id === systemId);
}

/** Tagged error for "no such system" cases. Caller maps to a wire code. */
export class GalaxySystemNotFoundError extends Error {
  readonly code = "system-not-found" as const;
  constructor(public readonly systemId: string) {
    super(`system not found: ${systemId}`);
    this.name = "GalaxySystemNotFoundError";
  }
}
