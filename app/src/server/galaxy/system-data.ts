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
 *
 * The function is pure (seed + starId in, context out). Tests can
 * assert determinism by calling it twice with the same inputs.
 *
 * @see ./router.ts for the consumer.
 * @see ../../shared/galaxy/system.ts for the upstream generator.
 */
import { generateStars } from "@shared/galaxy/stars.js";
import { generateSystem } from "@shared/galaxy/system.js";

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

  return {
    system,
    planetById: (planetId: string) => planetByIdMap.get(planetId),
    heightAtFor,
    tileSizeM: 64,
    // TASK-25: forward the galaxy seed so the regime manager can
    // place each planet in world space (deterministic from the
    // seed + star id). Callers that don't know the seed leave
    // this undefined; the sim falls back to the dev seed.
    galaxySeed: seed,
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
