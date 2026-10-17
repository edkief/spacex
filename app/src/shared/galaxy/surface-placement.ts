/**
 * Resource-node and landing-pad placement for the surface chunk
 * generator. Extracted from `surface.ts` so the main module can stay
 * focused on the public API and orchestration.
 *
 * Placement decisions all flow from a single per-chunk `Rng` (the
 * `placementSeed` from `surface.ts`). The two sub-systems are interleaved
 * in the public generator so that node-count and pad-coin-flip consume
 * their RNG draws in a fixed order — the canonical 30-test stability
 * loop in `surface.test.ts` relies on this ordering.
 *
 * @see ./surface.ts for the public API that consumes these functions.
 * @see ./config-surface.ts for `MIN_NODES_PER_CHUNK`,
 *      `NODE_PAD_MIN_DISTANCE_M`, `PAD_PROBABILITY`, etc.
 */

import { hash2, seedFromString } from "../random.js";
import type { Rng } from "../random.js";
import {
  CHUNK_SIZE_CELLS,
  ID_HEX_CHARS,
  MAX_NODES_PER_CHUNK,
  MAX_NODE_QUANTITY_EXCLUSIVE,
  MIN_NODES_PER_CHUNK,
  MIN_NODE_QUANTITY,
  NODE_MIN_SPACING_M,
  NODE_PLACEMENT_MAX_ATTEMPTS,
  PAD_BLOCK_SIZE_CELLS,
  PAD_PROBABILITY,
} from "./config-surface.js";
import type { Biome, LandingPad, ResourceNode, ResourceType } from "./types.js";

// ---------------------------------------------------------------------------
// Resource nodes
// ---------------------------------------------------------------------------

/**
 * Places 1..4 resource nodes in the chunk using seeded rejection
 * sampling. Wetland chunks return 0 nodes (solid resources don't spawn
 * in marshes); chunks where the planet declares no `resourceTypes` also
 * return 0 nodes.
 *
 * Node positions are chunk-local (0..63 in metres). Node ids are
 * hex-encoded `hash2` digests of `(seed, planetId, chunkX, chunkZ, nodeIndex)`,
 * so two clients agree on the id even if they disagree on other
 * presentation details (e.g. which sprite is shown).
 */
export function placeResourceNodes(
  rng: Rng,
  biome: Biome,
  resourceTypes: readonly ResourceType[],
  seed: string,
  planetId: string,
  chunkX: number,
  chunkZ: number,
): ResourceNode[] {
  if (resourceTypes.length === 0) return [];
  if (biome === "wetland") return [];

  const count = MIN_NODES_PER_CHUNK + rng.nextInt(MAX_NODES_PER_CHUNK - MIN_NODES_PER_CHUNK + 1);
  const placed: Array<{ x: number; z: number }> = [];
  const nodes: ResourceNode[] = [];

  for (let i = 0; i < count; i++) {
    const pos = sampleNodePosition(rng, placed);
    if (pos === null) continue; // couldn't find a non-overlapping spot
    placed.push(pos);

    const type = resourceTypes[rng.nextInt(resourceTypes.length)];
    const baseQuantity =
      MIN_NODE_QUANTITY + rng.nextInt(MAX_NODE_QUANTITY_EXCLUSIVE - MIN_NODE_QUANTITY);

    nodes.push({
      nodeId: nodeId(seed, planetId, chunkX, chunkZ, i),
      type,
      x: pos.x,
      z: pos.z,
      baseQuantity,
    });
  }

  return nodes;
}

/**
 * Rejection-sampling loop for resource-node positions. Returns the
 * first random position whose Chebyshev distance from every prior
 * position is at least `NODE_MIN_SPACING_M`. Returns `null` after
 * `NODE_PLACEMENT_MAX_ATTEMPTS` failures (extremely unlikely in
 * practice — the chunk is 60×60 minus the existing nodes).
 */
function sampleNodePosition(
  rng: Rng,
  existing: readonly { x: number; z: number }[],
): { x: number; z: number } | null {
  for (let attempt = 0; attempt < NODE_PLACEMENT_MAX_ATTEMPTS; attempt++) {
    const x = rng.nextInt(CHUNK_SIZE_CELLS);
    const z = rng.nextInt(CHUNK_SIZE_CELLS);
    if (isFarEnough({ x, z }, existing, NODE_MIN_SPACING_M)) {
      return { x, z };
    }
  }
  return null;
}

/** Chebyshev distance check against every existing position. */
function isFarEnough(
  candidate: { x: number; z: number },
  existing: readonly { x: number; z: number }[],
  minDistance: number,
): boolean {
  for (let i = 0; i < existing.length; i++) {
    const p = existing[i] as { x: number; z: number };
    if (Math.abs(p.x - candidate.x) < minDistance && Math.abs(p.z - candidate.z) < minDistance) {
      return false;
    }
  }
  return true;
}

/** Stable resource-node id. Hex of `hash2(hash2(chunkSeed, chunkKey), nodeIndex)`. */
export function nodeId(
  seed: string,
  planetId: string,
  chunkX: number,
  chunkZ: number,
  nodeIndex: number,
): string {
  const chunkSeed = chunkSeedDerivation(seed, planetId, chunkX, chunkZ);
  // Use the chunk coords as a second discriminator so that node ids
  // differ even if two chunks somehow share a chunk seed (defence in
  // depth — `chunkSeedDerivation` already makes this impossible).
  const withCoords = hash2(chunkSeed, BigInt(chunkX) * 0x100000000n + BigInt(chunkZ));
  return bigintToHex(hash2(withCoords, BigInt(nodeIndex)), ID_HEX_CHARS);
}

// ---------------------------------------------------------------------------
// Landing pads
// ---------------------------------------------------------------------------

/**
 * Places 0 or 1 landing pad in the chunk.
 *
 *   - Non-landable planet: never a pad.
 *   - Chunk `(0, 0)` of a landable planet: exactly one pad (forced).
 *   - Otherwise: pad with probability `PAD_PROBABILITY`.
 *
 * Pad position is the centre of the lowest-gradient `BLOCK_SIZE_CELLS × BLOCK_SIZE_CELLS`
 * block in the chunk; ties broken by `(x, z)` lexicographic order so
 * the choice is deterministic.
 */
export function placeLandingPads(
  rng: Rng,
  planetIsLandable: boolean,
  isFirstChunk: boolean,
  heightmap: readonly number[],
  seed: string,
  planetId: string,
  chunkX: number,
  chunkZ: number,
): LandingPad[] {
  if (!planetIsLandable) return [];

  // Forced pad on chunk (0, 0); otherwise a 25% roll.
  if (!isFirstChunk && rng.nextF64() >= PAD_PROBABILITY) return [];

  const pos = findFlatSpot(heightmap);
  return [
    {
      id: padId(seed, planetId, chunkX, chunkZ),
      x: pos.x,
      z: pos.z,
    },
  ];
}

/**
 * Locates the flattest `PAD_BLOCK_SIZE_CELLS × PAD_BLOCK_SIZE_CELLS`
 * block in the chunk and returns its centre. Deterministic: ties are
 * broken by lower `(x, z)`.
 */
function findFlatSpot(heightmap: readonly number[]): { x: number; z: number } {
  const block = PAD_BLOCK_SIZE_CELLS;
  let bestX = 0;
  let bestZ = 0;
  let bestGrad = Infinity;

  for (let bz = 0; bz <= CHUNK_SIZE_CELLS - block; bz++) {
    for (let bx = 0; bx <= CHUNK_SIZE_CELLS - block; bx++) {
      let minH = Infinity;
      let maxH = -Infinity;
      for (let dz = 0; dz < block; dz++) {
        for (let dx = 0; dx < block; dx++) {
          const h = heightmap[(bz + dz) * CHUNK_SIZE_CELLS + (bx + dx)] as number;
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
        }
      }
      const grad = maxH - minH;
      if (grad < bestGrad || (grad === bestGrad && (bz < bestZ || (bz === bestZ && bx < bestX)))) {
        bestGrad = grad;
        bestX = bx;
        bestZ = bz;
      }
    }
  }

  // Pad sits at the centre of the chosen block (not a cell corner).
  return { x: bestX + block / 2, z: bestZ + block / 2 };
}

/** Stable landing-pad id. Hex of `hash2(chunkSeed, PAD_DOMAIN_TAG)`. */
const PAD_DOMAIN_TAG = 0x1ec0ffee7n;
export function padId(seed: string, planetId: string, chunkX: number, chunkZ: number): string {
  const chunkSeed = chunkSeedDerivation(seed, planetId, chunkX, chunkZ);
  return bigintToHex(hash2(chunkSeed, PAD_DOMAIN_TAG), ID_HEX_CHARS);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic per-chunk seed by chaining `hash2` over
 * `(galaxySeed, planetId, chunkX, chunkZ)`. Used as the **placement**
 * RNG key (node count, node positions, pad roll, etc.) — varies per
 * chunk. The heightmap noise uses a separate per-planet seed so the
 * heightmap stays continuous across chunk borders.
 */
export function chunkSeedDerivation(
  seed: string,
  planetId: string,
  chunkX: number,
  chunkZ: number,
): bigint {
  const galaxySeed = seedFromString(seed);
  const planetIdSeed = seedFromString(planetId);
  // Hash1: galaxy + planet. Hash2: hash1 + chunkX. Hash3: hash2 + chunkZ.
  const a = hash2(galaxySeed, planetIdSeed);
  const b = hash2(a, BigInt(chunkX));
  return hash2(b, BigInt(chunkZ));
}

/** Renders a `bigint` as a zero-padded lowercase hex string of `width` chars. */
export function bigintToHex(value: bigint, width: number): string {
  const hex = value.toString(16);
  return hex.length >= width ? hex : "0".repeat(width - hex.length) + hex;
}
