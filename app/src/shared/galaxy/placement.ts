import { hash2, hex64, type Rng } from '../random.ts';
import { round1 } from './quantize.ts';
import { CHUNK_SIZE_M, type SurfaceField } from './terrain.ts';
import type { LandingPad, Planet, ResourceNode } from './types.ts';

const PAD_SALT = 0x706164n;
const PAD_CHANCE = 0.25;
const PAD_MARGIN_M = 20;
const NODE_MARGIN_M = 4;
const NODE_PAD_CLEARANCE_M = 20;
const PAD_CANDIDATES = 12;
const FLATNESS_PROBE_M = 6;
const NODE_ATTEMPTS = 32;
const LIQUID_OR_GAS = new Set(['water', 'gas-compounds']);

/** World-space origin (metres) of a chunk's lower corner. */
interface ChunkOrigin {
  x0: number;
  z0: number;
}

/** Steepness at a point: the largest height change to the 4 probes `FLATNESS_PROBE_M` away. */
function steepness(field: SurfaceField, x: number, z: number): number {
  const h = field.heightAt(x, z);
  const d = FLATNESS_PROBE_M;
  return Math.max(
    Math.abs(field.heightAt(x + d, z) - h),
    Math.abs(field.heightAt(x - d, z) - h),
    Math.abs(field.heightAt(x, z + d) - h),
    Math.abs(field.heightAt(x, z - d) - h),
  );
}

/** Draws a world position inside the chunk, at least `margin` metres from every edge. */
function drawPosition(rng: Rng, origin: ChunkOrigin, margin: number): { x: number; z: number } {
  const span = CHUNK_SIZE_M - 2 * margin;
  return {
    x: round1(origin.x0 + margin + rng.nextF64() * span),
    z: round1(origin.z0 + margin + rng.nextF64() * span),
  };
}

/**
 * Places at most one landing pad: with probability 0.25 (always for chunk 0,0 of a landable
 * planet), at the flattest of 12 seeded candidates. Pads stay 20 m inside the chunk edge so
 * neighbouring chunks' nodes can never crowd them.
 */
export function placePads(
  rng: Rng,
  chunkSeed: bigint,
  origin: ChunkOrigin,
  field: SurfaceField,
  planet: Planet,
  isOriginChunk: boolean,
): LandingPad[] {
  const wanted = planet.landable && (isOriginChunk || rng.chance(PAD_CHANCE));
  if (!wanted) return [];
  let best: { x: number; z: number } | undefined;
  let bestSteepness = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PAD_CANDIDATES; i++) {
    const candidate = drawPosition(rng, origin, PAD_MARGIN_M);
    const score = steepness(field, candidate.x, candidate.z);
    if (score < bestSteepness) {
      best = candidate;
      bestSteepness = score;
    }
  }
  if (!best) return [];
  return [{ id: hex64(hash2(chunkSeed, PAD_SALT)), x: best.x, z: best.z }];
}

/** True when (x, z) is at least the clearance away from every pad. */
function clearOfPads(x: number, z: number, pads: readonly LandingPad[]): boolean {
  return pads.every((pad) => {
    const dx = pad.x - x;
    const dz = pad.z - z;
    return dx * dx + dz * dz >= NODE_PAD_CLEARANCE_M * NODE_PAD_CLEARANCE_M;
  });
}

/** Spacing and count of the deterministic fallback probe grid used by `placeNodes`. */
export const PROBE_GRID_SPACING_M = 16;
export const PROBE_GRID_SIZE = 16;

/** True for resource types that need solid ground (everything except water and gas). */
function isSolid(type: string): boolean {
  return !LIQUID_OR_GAS.has(type);
}

/**
 * Finds a position for one node. Seeded rejection sampling (32 draws) first; if every draw is
 * wetland or near a pad, a 16x16 probe grid (16 m spacing) is scanned from a seeded start for
 * the first clear non-wetland point. Only when the whole chunk is wetland (or pad-covered) does
 * a solid node fall back to the least-wet clear random draw.
 */
function findNodePosition(
  rng: Rng,
  origin: ChunkOrigin,
  field: SurfaceField,
  solid: boolean,
  pads: readonly LandingPad[],
): { x: number; z: number } {
  let leastWet: { x: number; z: number } | undefined;
  let leastWetness = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < NODE_ATTEMPTS; attempt++) {
    const candidate = drawPosition(rng, origin, NODE_MARGIN_M);
    if (!clearOfPads(candidate.x, candidate.z, pads)) continue;
    if (!solid || field.biomeAt(candidate.x, candidate.z) !== 'wetland') return candidate;
    const wetness = field.moistureAt(candidate.x, candidate.z);
    if (wetness < leastWetness) {
      leastWet = candidate;
      leastWetness = wetness;
    }
  }
  const total = PROBE_GRID_SIZE * PROBE_GRID_SIZE;
  const start = rng.nextInt(total);
  for (let step = 0; step < total; step++) {
    const cell = (start + step) % total;
    const x = origin.x0 + NODE_MARGIN_M + (cell % PROBE_GRID_SIZE) * PROBE_GRID_SPACING_M;
    const z = origin.z0 + NODE_MARGIN_M + Math.floor(cell / PROBE_GRID_SIZE) * PROBE_GRID_SPACING_M;
    if (clearOfPads(x, z, pads) && field.biomeAt(x, z) !== 'wetland') return { x, z };
  }
  return leastWet ?? drawPosition(rng, origin, NODE_MARGIN_M);
}

/**
 * Places 1-4 resource nodes of the planet's resource types, 20 m clear of pads, with solid
 * resources kept out of wetland (see `findNodePosition` for the deterministic fallbacks).
 */
export function placeNodes(
  rng: Rng,
  chunkSeed: bigint,
  origin: ChunkOrigin,
  field: SurfaceField,
  planet: Planet,
  pads: readonly LandingPad[],
): ResourceNode[] {
  const count = 1 + rng.nextInt(4);
  const nodes: ResourceNode[] = [];
  for (let index = 0; index < count; index++) {
    const type = rng.pick(planet.resourceTypes);
    const position = findNodePosition(rng, origin, field, isSolid(type), pads);
    nodes.push({
      nodeId: hex64(hash2(chunkSeed, BigInt(index))),
      type,
      x: round1(position.x),
      z: round1(position.z),
      baseQuantity: 50 + rng.nextInt(151),
    });
  }
  return nodes;
}
