/**
 * Deterministic planet surface-chunk generation (TASK-5).
 *
 * generateSurfaceChunk(seed, planet, chunkX, chunkZ) returns a SurfaceChunk
 * that any client can reconstruct identically with no server data. The
 * heightfield is a planet-wide field (seeded only from seed + planetId)
 * sampled in *world* cell space, so neighboring chunks share boundary
 * samples exactly (see noise.ts); the per-chunk sub-seed
 * (seed, planetId, chunkX, chunkZ) drives only placement draws. Heights are
 * integer meters, Uint16-safe.
 *
 * Fixed draw order from the chunk Rng (documented for stability):
 *   1. pad presence roll (landable planets only)
 *   2. pad candidate positions + flat-area scan
 *   3. node count, then per node: type, position (rejection draws), quantity
 */

import { hash2, seedFromString, Rng } from '../random.js';
import { makeNoiseChannel } from './noise.js';
import type { Biome, LandingPad, Planet, ResourceNode, SurfaceChunk } from './types.js';

/** Cells per chunk on one axis (64x64 heightmap). */
export const CHUNK_SIZE = 64;
/** Meters per heightmap cell. */
export const CELL_SIZE_M = 5;
/** Max extractable per node (baseQuantity in [50, 200]). */
export const NODE_MAX_QUANTITY = 200;
/** Nodes must sit this far from a landing pad. */
export const NODE_PAD_CLEARANCE_M = 20;
/** A landing pad needs a 3x3 cell patch no steeper than this (meters). */
export const PAD_FLAT_TOL_M = 4;

/** Cell coords (x, z) of the 16 heightmap points committed in golden fixtures. */
export const HEIGHTMAP_SAMPLE_CELLS: ReadonlyArray<readonly [number, number]> = [
  [8, 8],
  [24, 8],
  [40, 8],
  [56, 8],
  [8, 24],
  [24, 24],
  [40, 24],
  [56, 24],
  [8, 40],
  [24, 40],
  [40, 40],
  [56, 40],
  [8, 56],
  [24, 56],
  [40, 56],
  [56, 56],
];

/** Resource types excluded from the wetland-avoidance rule (they form wetlands). */
const LIQUID_RESOURCES = new Set(['water', 'gas-compounds']);

/** 16-hex-char id from a sub-seed (same format as planet/star ids). */
function hexId(subSeed: bigint): string {
  return subSeed.toString(16).padStart(16, '0');
}

/**
 * Chunk sub-seed: hash over the (seed, planetId, chunkX, chunkZ) tuple.
 * Chunk coordinates are folded as unsigned 32-bit halves, exact for any
 * reachable |chunkCoord| < 2^31.
 */
export function chunkSeed(seed: string, planetId: string, chunkX: number, chunkZ: number): bigint {
  const master = hash2(seedFromString(seed), seedFromString(planetId));
  const xy = ((BigInt(chunkX) & 0xffffffffn) << 32n) | (BigInt(chunkZ) & 0xffffffffn);
  return hash2(master, xy);
}

/** Terrain amplitude in meters, scaled by planet radius (gentler on small worlds). */
export function amplitudeM(planet: Pick<Planet, 'radiusKm'>): number {
  return 250 + (planet.radiusKm / 8000) * 350;
}

/**
 * The planet-wide noise channels + amplitude, seeded ONLY from
 * (seed, planetId) — every chunk and every consumer (server TerrainContext,
 * client streaming pipeline TASK-26) must sample this exact field so
 * boundary cells match across chunk borders by construction.
 */
export function heightfieldChannels(seed: string, planet: Pick<Planet, 'id' | 'radiusKm'>) {
  const planetField = hash2(seedFromString(seed), seedFromString(planet.id));
  return {
    height: makeNoiseChannel(planetField),
    moisture: makeNoiseChannel(hash2(planetField, seedFromString('moisture'))),
    amp: amplitudeM(planet),
  };
}

/**
 * Pick the chunk biome from the center cell's normalized height (h in 0..1)
 * and moisture (m in 0..1). Ice-class worlds can be frozen; wetlands are
 * driven by the moisture channel.
 */
function pickBiome(planet: Planet, h: number, m: number): Biome {
  if (planet.class === 'ice' && h < 0.5) return 'frozen';
  if (m > 0.7) return 'wetland';
  if (h > 0.75) return 'canyon';
  if (h > 0.55 || m < 0.18) return 'rock';
  return 'plains';
}

/**
 * Find a pad position: up to 8 seeded candidate cells, each snapped to the
 * flattest 3x3 patch within 4 cells (deterministic ring order). Falls back
 * to the chunk center so a pad always exists when one is due.
 */
function findPadPosition(
  rng: Rng,
  heightAt: (cellX: number, cellZ: number) => number,
): { x: number; z: number } {
  const inRange = (n: number) => n >= 0 && n < CHUNK_SIZE;
  const patchDelta = (cx: number, cz: number): number => {
    let min = Infinity;
    let max = -Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!inRange(cx + dx) || !inRange(cz + dz)) continue;
        const h = heightAt(cx + dx, cz + dz);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    return max - min;
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    const cx = 8 + rng.nextInt(48);
    const cz = 8 + rng.nextInt(48);
    let bestD = Infinity;
    let bestX = cx;
    let bestZ = cz;
    for (let ring = 0; ring <= 4; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          // Deterministic order: rings ascending, then dx, then dz.
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const px = cx + dx;
          const pz = cz + dz;
          if (!inRange(px) || !inRange(pz)) continue;
          const d = patchDelta(px, pz);
          if (d < bestD) {
            bestD = d;
            bestX = px;
            bestZ = pz;
          }
        }
      }
    }
    if (bestD <= PAD_FLAT_TOL_M) return { x: bestX, z: bestZ };
  }
  return { x: 32, z: 32 };
}

/**
 * The placement pass of generateSurfaceChunk (biome + pads + nodes) as a
 * standalone step over a finished heightmap. The client's frame-sliced
 * generator (TASK-26) runs exactly this after generating the heightmap in
 * row slices; the code is bit-identical to the original inline version, so
 * staged and one-shot generation produce the same SurfaceChunk.
 */
export function generateChunkPlacement(
  seed: string,
  planet: Planet,
  chunkX: number,
  chunkZ: number,
  heightmap: number[],
): { biome: Biome; landingPads: LandingPad[]; resourceNodes: ResourceNode[] } {
  // The per-chunk sub-seed drives only placement draws (pads, nodes), which
  // may differ per chunk; the terrain field itself is planet-wide.
  const sub = chunkSeed(seed, planet.id, chunkX, chunkZ);
  const { moisture, amp } = heightfieldChannels(seed, planet);
  const heightAt = (cellX: number, cellZ: number) => heightmap[cellZ * CHUNK_SIZE + cellX];

  const centerH = heightAt(CHUNK_SIZE >> 1, CHUNK_SIZE >> 1);
  const centerM = moisture.fbm01(
    chunkX * CHUNK_SIZE + (CHUNK_SIZE >> 1),
    chunkZ * CHUNK_SIZE + (CHUNK_SIZE >> 1),
  );
  const biome = pickBiome(planet, centerH / amp, centerM);

  const rng = new Rng(hash2(sub, seedFromString('placement')));
  const landingPads: LandingPad[] = [];
  const resourceNodes: ResourceNode[] = [];

  if (planet.landable) {
    // Pad first: nodes reject against it, and (0,0) is forced to one pad.
    const padDue = (chunkX === 0 && chunkZ === 0) || rng.nextF64() < 0.25;
    if (padDue) {
      const pos = findPadPosition(rng, heightAt);
      landingPads.push({
        id: hexId(hash2(sub, seedFromString('pad'))),
        x: pos.x * CELL_SIZE_M,
        z: pos.z * CELL_SIZE_M,
      });
    }

    const liquidTypes = planet.resourceTypes.filter((t) => LIQUID_RESOURCES.has(t));
    const nodeCount = 1 + rng.nextInt(4); // 1..4
    for (let i = 0; i < nodeCount; i++) {
      // Solid resources never form in wetlands: redraw the type when a solid
      // lands on a wetland chunk that also hosts liquid resources.
      let type = rng.pick(planet.resourceTypes);
      if (biome === 'wetland' && !LIQUID_RESOURCES.has(type) && liquidTypes.length > 0) {
        type = rng.pick(liquidTypes);
      }
      const clearanceCells = Math.ceil(NODE_PAD_CLEARANCE_M / CELL_SIZE_M);
      let nx = 4;
      let nz = 4;
      for (let tries = 0; tries < 96; tries++) {
        nx = 4 + rng.nextInt(56);
        nz = 4 + rng.nextInt(56);
        const ok = landingPads.every((p) => {
          const dx = (p.x - nx * CELL_SIZE_M) / CELL_SIZE_M;
          const dz = (p.z - nz * CELL_SIZE_M) / CELL_SIZE_M;
          return Math.max(Math.abs(dx), Math.abs(dz)) >= clearanceCells;
        });
        if (ok) break;
      }
      resourceNodes.push({
        nodeId: hexId(hash2(sub, BigInt(i))),
        type,
        x: nx * CELL_SIZE_M,
        z: nz * CELL_SIZE_M,
        baseQuantity: 50 + rng.nextInt(NODE_MAX_QUANTITY - 50 + 1), // 50..200
      });
    }
  }

  return { biome, landingPads, resourceNodes };
}

/**
 * Deterministically generate one surface chunk of a planet.
 *
 * - Heightmap: 64x64 integer meters from 5-octave fBm in world cell space.
 * - Biome: from the center cell's height + a second (moisture) noise channel.
 * - Pads: always 1 on chunk (0,0) of a landable planet; else 25% seeded roll.
 * - Nodes: 1-4, types restricted to planet.resourceTypes, rejection-sampled to
 *   stay >= 20 m from pads; solid types are re-rolled to liquid types on
 *   wetland chunks when the planet hosts liquid resources.
 * Non-landable planets get terrain + biome but no nodes or pads.
 */
export function generateSurfaceChunk(
  seed: string,
  planet: Planet,
  chunkX: number,
  chunkZ: number,
): SurfaceChunk {
  const { height, amp } = heightfieldChannels(seed, planet);

  // Heightmap in world cell space: worldCoord = chunk * CHUNK_SIZE + cell.
  const heightmap: number[] = new Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      heightmap[z * CHUNK_SIZE + x] = Math.round(
        height.fbm01(chunkX * CHUNK_SIZE + x, chunkZ * CHUNK_SIZE + z) * amp,
      );
    }
  }
  const { biome, landingPads, resourceNodes } = generateChunkPlacement(
    seed,
    planet,
    chunkX,
    chunkZ,
    heightmap,
  );
  return { chunkX, chunkZ, heightmap, biome, resourceNodes, landingPads };
}
