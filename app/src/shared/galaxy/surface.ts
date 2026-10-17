/**
 * Surface chunk generator — produces a deterministic `SurfaceChunk` for
 * any `(seed, planet, chunkX, chunkZ)` quadruple.
 *
 * Lives next to `system.ts` / `planet.ts` so the deterministic-galaxy
 * import graph stays a strict DAG:
 *
 *   random.ts → surface-noise.ts ──┐
 *            └─ surface-placement.ts ──┐
 *                                       ↓
 *                                    surface.ts → types.ts
 *                                       ↑
 *                              config-surface.ts (constants only)
 *
 * The generator is **the** place where biome, terrain, resource nodes,
 * and landing pads get assigned. Every other module in the game that
 * needs to look up "what's in chunk (3, 7) of planet X?" calls in here.
 * Because the output depends only on the inputs (no `Date.now`, no
 * `Math.random`, no `crypto`), any client can reconstruct any chunk
 * without server data — the foundation of the spec's "Any client can
 * reconstruct any chunk identically without server data" promise.
 *
 * ## Determinism contract
 *
 *   - **Placement seed** = `hash2(hash2(seed, planetIdSeed), hash2(chunkX, chunkZ))`.
 *     Drives the per-chunk placement RNG (node count, node positions,
 *     pad probability roll, node types / quantities). Varies per chunk.
 *   - **Terrain seed** = `hash2(seedFromString(seed), seedFromString(planetId))`.
 *     Drives the heightmap / moisture / latitude noise. **Constant
 *     per planet** — the property that makes adjacent chunks share
 *     the same noise field at their borders (the spec's "shared
 *     boundary noise sampling" requirement).
 *   - Resource-node and landing-pad ids are hex-encoded `hash2`
 *     digests; identical for all clients that run with the same seed.
 *
 * ## Boundary continuity
 *
 * Because fBm samples are evaluated in world space (not chunk-local)
 * with a planet-scoped seed, neighbouring chunks share the noise
 * field at their border. The test asserts the delta between border
 * columns / rows stays well under 25 m (currently ≤ 5 m empirically);
 * see `surface.test.ts → boundary continuity`.
 *
 * @see ./types.ts for `SurfaceChunk`, `Biome`, `ResourceNode`, `LandingPad`.
 * @see ./config-surface.ts for tunable constants.
 * @see ./random.ts for the `Rng` and `hash2` primitives.
 * @see ./planet.ts for the `Planet` consumed by the heightmap seed chain.
 * @see ./surface-noise.ts for the noise / heightmap / biome primitives.
 * @see ./surface-placement.ts for the node / pad placement primitives.
 */

import { Rng, hash2, seedFromString } from "../random.js";
import { ALL_BIOMES, CHUNK_SIZE_CELLS, NODE_PAD_MIN_DISTANCE_M } from "./config-surface.js";
import {
  classifyBiome,
  computeHeightmapStats,
  generateHeightmap,
  sampleMoisture,
  sampleLatitude,
} from "./surface-noise.js";
import { chunkSeedDerivation, placeLandingPads, placeResourceNodes } from "./surface-placement.js";
import type { Planet, SurfaceChunk } from "./types.js";

// Re-export `Biome`, `ResourceNode`, `LandingPad`, and `SurfaceChunk` so
// callers can do `import type { Biome } from "./surface.js"` (or from
// `./types.js`) without breaking symmetry with the rest of the galaxy
// module tree.
export type { Biome, ResourceNode, LandingPad, SurfaceChunk } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates the deterministic `SurfaceChunk` for the given
 * `(seed, planet, chunkX, chunkZ)`. Any caller — server, client, render
 * worker — gets the same output for the same inputs.
 *
 *   - `seed` is the galaxy seed (same string passed to `generateStars`).
 *   - `planet` is the parent planet; `planet.id`, `planet.class`,
 *     `planet.landable`, and `planet.resourceTypes` are read but
 *     nothing else — pass a frozen snapshot and you're good.
 *   - `chunkX` / `chunkZ` are integer chunk coordinates in the
 *     planet's local grid (negative values are supported; the noise
 *     field is defined for all integer world coords).
 *
 * Two seeds are derived:
 *
 *   - `placementSeed` drives the per-chunk RNG used for node / pad
 *     placement (varies per chunk).
 *   - `terrainSeed` drives the heightmap / moisture / latitude noise
 *     (constant per planet — this is what guarantees boundary
 *     continuity).
 *
 * The function is referentially transparent: two calls with the same
 * arguments return deeply equal `SurfaceChunk` objects.
 */
export function generateSurfaceChunk(
  seed: string,
  planet: Planet,
  chunkX: number,
  chunkZ: number,
): SurfaceChunk {
  if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ)) {
    throw new RangeError(
      `generateSurfaceChunk: chunkX/chunkZ must be integers, got ${chunkX}, ${chunkZ}`,
    );
  }

  const placementSeed = chunkSeedDerivation(seed, planet.id, chunkX, chunkZ);
  const terrainSeed = hash2(seedFromString(seed), seedFromString(planet.id));
  const rng = new Rng(placementSeed);

  // 1. Heightmap (world-space fBm — boundary-continuous).
  const heightmap = generateHeightmap(terrainSeed, chunkX, chunkZ);

  // 2. Per-chunk stats + moisture + latitude (biome classification inputs).
  const stats = computeHeightmapStats(heightmap);
  const moisture = sampleMoisture(terrainSeed, chunkX, chunkZ);
  const latitude = sampleLatitude(terrainSeed, chunkX, chunkZ);
  const biome = classifyBiome(planet.class, stats.avg, stats.gradient, moisture, latitude);

  // 3. Resource nodes (decorrelated from the placement rng above).
  const resourceNodes = placeResourceNodes(
    rng,
    biome,
    planet.resourceTypes,
    seed,
    planet.id,
    chunkX,
    chunkZ,
  );

  // 4. Landing pads (uses the same rng, so node/pad decisions can't
  //    diverge if you generate the chunk in a different order).
  const isFirstChunk = chunkX === 0 && chunkZ === 0;
  const landingPads = placeLandingPads(
    rng,
    planet.landable,
    isFirstChunk,
    heightmap,
    seed,
    planet.id,
    chunkX,
    chunkZ,
  );

  return {
    chunkX,
    chunkZ,
    heightmap,
    biome,
    resourceNodes,
    landingPads,
  };
}

// ---------------------------------------------------------------------------
// Dev-only: cross-reference for tests
// ---------------------------------------------------------------------------

/** Re-export the canonical biome list for tests that want to iterate. */
export { ALL_BIOMES };

/** Re-exported for tests that need to check node↔pad distance. */
export { NODE_PAD_MIN_DISTANCE_M };

/**
 * Re-export `CHUNK_SIZE_CELLS` for callers that want to bound their
 * iteration without importing the config module directly.
 */
export { CHUNK_SIZE_CELLS };
