/**
 * Noise primitives for the surface chunk generator.
 *
 * Owns the 2-D value-noise + fBm stack that drives the heightmap,
 * moisture channel, and latitude channel of every surface chunk.
 * Extracted from `surface.ts` so the main module can stay focused on
 * the public API and orchestration; importing this directly is
 * supported (the parity test's source-purity check targets the
 * surface-noise module alongside surface.ts).
 *
 * The big design constraint here is **boundary continuity**: adjacent
 * chunks must read from the same noise field at world `(wx, wz)`
 * coordinates so the cell at the right edge of chunk `(0, 0)` agrees
 * with the cell at the left edge of chunk `(1, 0)` to within the
 * noise gradient. Two consequences:
 *
 *   - The lattice hash is keyed by `seed + (ix, iz)` (world coords),
 *     NOT by `(chunkX, chunkZ, ix, iz)` (chunk-local). The caller is
 *     responsible for passing a per-planet `terrainSeed` (constant
 *     across chunks) — see `surface.ts`.
 *   - `fbm` evaluates octaves at *world* coords, with the smallest
 *     octave's lattice aligned to the 1 m cell size so the
 *     smoothstep-interpolated samples line up with the heightmap.
 *
 * @see ./surface.ts for the public API that consumes these primitives.
 * @see ./config-surface.ts for the tunable `FBM_*`, `MOISTURE_FBM_*`,
 *      and `LATITUDE_FBM_*` constants.
 */

import { hash2 } from "../random.js";
import type { Biome } from "./types.js";
import {
  CANYON_MIN_ELEVATION,
  CANYON_MIN_GRADIENT,
  FBM_BASE_LATTICE_SPACING_M,
  FBM_GAIN,
  FBM_LACUNARITY,
  FBM_OCTAVES,
  FROZEN_LATITUDE_THRESHOLD,
  FROZEN_LATITUDE_THRESHOLD_ICE,
  LATITUDE_FBM_BASE_LATTICE_SPACING_M,
  LATITUDE_FBM_GAIN,
  LATITUDE_FBM_LACUNARITY,
  LATITUDE_FBM_OCTAVES,
  MOISTURE_FBM_BASE_LATTICE_SPACING_M,
  MOISTURE_FBM_GAIN,
  MOISTURE_FBM_LACUNARITY,
  MOISTURE_FBM_OCTAVES,
  PEAK_HEIGHT_M,
  ROCK_MIN_ELEVATION,
  WETLAND_MAX_ELEVATION,
  WETLAND_MOISTURE_THRESHOLD,
} from "./config-surface.js";

// ---------------------------------------------------------------------------
// Noise primitives
// ---------------------------------------------------------------------------

/**
 * Smoothstep easing — `3t² - 2t³`. Standard cubic Hermite, C¹-continuous
 * with derivative 0 at t=0 and t=1. Used for bilinear lattice
 * interpolation in `valueNoise2D`.
 */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Hashes a lattice point `(seed, ix, iz)` to a value in `[0, 1)`.
 *
 * Uses Number + `Math.imul` arithmetic (MurmurHash3-style finalizer)
 * instead of the BigInt-based `hash2` chain because the noise function
 * is the hot path: a chunk generation calls `latticeValue` ~32 000
 * times (3 octaves × 4 corners × 4096 cells ÷ 1.6 from the cache that
 * V8 builds for the lattice points), and BigInt arithmetic is ~25×
 * slower than Number. The trade-off is a slightly weaker avalanche
 * guarantee on lattice points that share coordinates, which is
 * compensated by mixing the `seed` bigint through both halves at the
 * start (`low ^ high`) — two adjacent lattice points produce
 * decorrelated outputs as long as the seed is varied.
 *
 * Distribution: uniform across [0, 1) at 32-bit resolution.
 */
function latticeValue(seed: bigint, ix: number, iz: number): number {
  // Seed → U32: XOR the low and high halves of the 64-bit seed so
  // that two seeds that differ only in their upper bits still produce
  // different lattice streams.
  const seedMix = (Number(seed & 0xffffffffn) ^ Number((seed >> 32n) & 0xffffffffn)) >>> 0;
  let h = seedMix;
  h = (h ^ (ix | 0)) >>> 0;
  h = Math.imul(h, 0x9e3779b1) >>> 0;
  h = (h ^ (iz | 0)) >>> 0;
  h = Math.imul(h, 0x9e3779b1) >>> 0;
  // MurmurHash3 32-bit finalizer — strong avalanche for U32 inputs.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/**
 * 2-D value noise sampled at world `(x, z)` using bilinear interpolation
 * with smoothstep easing. Returns a value in `[0, 1)`.
 *
 * `(x, z)` are in lattice-cell units (not metres) — `fbm` handles the
 * world→lattice scaling via `frequency / baseSpacing`.
 */
function valueNoise2D(seed: bigint, x: number, z: number): number {
  const ix0 = Math.floor(x);
  const iz0 = Math.floor(z);
  const fx = x - ix0;
  const fz = z - iz0;

  const v00 = latticeValue(seed, ix0, iz0);
  const v10 = latticeValue(seed, ix0 + 1, iz0);
  const v01 = latticeValue(seed, ix0, iz0 + 1);
  const v11 = latticeValue(seed, ix0 + 1, iz0 + 1);

  const sx = smoothstep(fx);
  const sz = smoothstep(fz);

  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sz;
}

/**
 * Fractional Brownian motion (fBm) — a sum of `octaves` value-noise
 * octaves at successively doubling frequencies and halving amplitudes.
 *
 * Returns a value in `[0, 1)` (after normalisation by the total
 * amplitude). The normalisation keeps the noise field bounded
 * regardless of the octave count, which matters because we then scale
 * by `PEAK_HEIGHT_M` to get metres.
 */
function fbm(
  seed: bigint,
  x: number,
  z: number,
  octaves: number,
  gain: number,
  lacunarity: number,
  baseSpacing: number,
): number {
  let total = 0;
  let amplitude = 1;
  let frequency = 1 / baseSpacing; // lattice-spacing → world-coord scaling
  let maxAmp = 0;

  for (let i = 0; i < octaves; i++) {
    total += amplitude * valueNoise2D(seed, x * frequency, z * frequency);
    maxAmp += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return total / maxAmp;
}

// ---------------------------------------------------------------------------
// Heightmap
// ---------------------------------------------------------------------------

/** Average, min, and max of a heightmap (in metres). */
export interface HeightmapStats {
  avg: number;
  min: number;
  max: number;
  /** `max - min`, in metres. Used by the canyon-biome classifier. */
  gradient: number;
}

/**
 * Generates the 64×64 row-major heightmap for the chunk. Each cell is
 * sampled at its world coordinate (`chunkX * 64 + i`, `chunkZ * 64 + j`)
 * so adjacent chunks share the noise field at their boundary.
 *
 * Output is `Math.round(fbm * PEAK_HEIGHT_M)` — integer metres, in the
 * `[0, PEAK_HEIGHT_M]` range. The Uint16-equivalent contract is
 * satisfied because `PEAK_HEIGHT_M = 2000 < 65 535`.
 */
export function generateHeightmap(terrainSeed: bigint, chunkX: number, chunkZ: number): number[] {
  const CHUNK = 64;
  const heightmap = new Array<number>(CHUNK * CHUNK);
  const baseX = chunkX * CHUNK;
  const baseZ = chunkZ * CHUNK;

  for (let j = 0; j < CHUNK; j++) {
    for (let i = 0; i < CHUNK; i++) {
      const wx = baseX + i;
      const wz = baseZ + j;
      const n = fbm(
        terrainSeed,
        wx,
        wz,
        FBM_OCTAVES,
        FBM_GAIN,
        FBM_LACUNARITY,
        FBM_BASE_LATTICE_SPACING_M,
      );
      heightmap[j * CHUNK + i] = Math.round(n * PEAK_HEIGHT_M);
    }
  }

  return heightmap;
}

/** Computes the per-chunk stats used by the biome classifier. */
export function computeHeightmapStats(heightmap: readonly number[]): HeightmapStats {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heightmap.length; i++) {
    const h = heightmap[i] as number;
    sum += h;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  const avg = sum / heightmap.length;
  return { avg, min, max, gradient: max - min };
}

// ---------------------------------------------------------------------------
// Moisture + latitude channels
// ---------------------------------------------------------------------------

/** Domain tag mixed into the chunk seed for the moisture channel. */
const MOISTURE_DOMAIN_TAG = 0x5e1d1aa1n;

/** Domain tag mixed into the chunk seed for the latitude channel. */
const LATITUDE_DOMAIN_TAG = 0xc011ec01n;

/**
 * Samples the moisture channel at the chunk centre. The chunk's centre
 * (rather than per-cell) is enough because moisture is a low-frequency
 * signal — its value barely changes across the 64 m of a chunk.
 */
export function sampleMoisture(seed: bigint, chunkX: number, chunkZ: number): number {
  const CHUNK = 64;
  const moistureSeed = hash2(seed, MOISTURE_DOMAIN_TAG);
  const cx = chunkX * CHUNK + CHUNK / 2;
  const cz = chunkZ * CHUNK + CHUNK / 2;
  return fbm(
    moistureSeed,
    cx,
    cz,
    MOISTURE_FBM_OCTAVES,
    MOISTURE_FBM_GAIN,
    MOISTURE_FBM_LACUNARITY,
    MOISTURE_FBM_BASE_LATTICE_SPACING_M,
  );
}

/**
 * Samples the latitude channel at the chunk centre. Acts as a "cold
 * bias" that biases `frozen` biomes toward certain chunk coordinates —
 * the planet's poles live somewhere in this noise field.
 */
export function sampleLatitude(seed: bigint, chunkX: number, chunkZ: number): number {
  const CHUNK = 64;
  const latitudeSeed = hash2(seed, LATITUDE_DOMAIN_TAG);
  const cx = chunkX * CHUNK + CHUNK / 2;
  const cz = chunkZ * CHUNK + CHUNK / 2;
  return fbm(
    latitudeSeed,
    cx,
    cz,
    LATITUDE_FBM_OCTAVES,
    LATITUDE_FBM_GAIN,
    LATITUDE_FBM_LACUNARITY,
    LATITUDE_FBM_BASE_LATTICE_SPACING_M,
  );
}

// ---------------------------------------------------------------------------
// Biome classification
// ---------------------------------------------------------------------------

/**
 * Picks one of the 5 `Biome` values from the elevation / moisture /
 * latitude triple. Rules (ordered — first match wins):
 *
 *   1. High latitude → `frozen` (planet class lowers the threshold for ice worlds).
 *   2. High gradient + moderate elevation → `canyon`.
 *   3. High moisture + low elevation → `wetland`.
 *   4. High elevation → `rock`.
 *   5. Default → `plains`.
 *
 * Order matters: a chunk could theoretically satisfy multiple criteria
 * (e.g. high latitude AND high moisture), and the order pins down the
 * deterministic outcome.
 */
export function classifyBiome(
  planetClass: string,
  avgHeight: number,
  gradient: number,
  moisture: number,
  latitude: number,
): Biome {
  // Normalised metrics — gradient normalised to PEAK_HEIGHT_M.
  const nh = avgHeight / PEAK_HEIGHT_M;
  const ng = gradient / PEAK_HEIGHT_M;

  // Frozen: high latitude (lower threshold for ice-class worlds).
  const frozenThreshold =
    planetClass === "ice" ? FROZEN_LATITUDE_THRESHOLD_ICE : FROZEN_LATITUDE_THRESHOLD;
  if (latitude > frozenThreshold) return "frozen";

  // Canyon: high gradient + moderate elevation.
  if (ng >= CANYON_MIN_GRADIENT && nh >= CANYON_MIN_ELEVATION) return "canyon";

  // Wetland: high moisture + low elevation.
  if (moisture >= WETLAND_MOISTURE_THRESHOLD && nh < WETLAND_MAX_ELEVATION) return "wetland";

  // Rock: high elevation.
  if (nh >= ROCK_MIN_ELEVATION) return "rock";

  // Default.
  return "plains";
}
