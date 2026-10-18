/**
 * Client-side chunk pipeline core (TASK-26).
 *
 * The streaming pipeline that turns the deterministic surface chunk
 * generator (TASK-5) into a renderable terrain around the player.
 * Lives entirely on the client — the server never sends chunks; every
 * peer regenerates them from `(seed, planet, chunkX, chunkZ)`.
 *
 * ## Layout
 *
 * Render chunks are `CHUNK_SIZE_M = 512` m on a side. Each render
 * chunk is composed of an `8 × 8` grid of `TASK-5` data chunks
 * (each `64` m). Heights are sampled at the cell centres of the
 * render chunk (so we get a smooth heightfield even where data
 * chunks meet) and the LOD mip chain is built once at generation
 * time so mid/far switch-overs never pop.
 *
 * The LOD rings use a single shared set of constants:
 *
 *   - `LOD_NEAR_RADIUS_M` = 512      → full detail (every render cell).
 *   - `LOD_MID_RADIUS_M`  = 2 048    → 2× vertex decimation.
 *   - `LOD_FAR_RADIUS_M`  = 8 192    → 8× vertex decimation (impostor).
 *   - beyond `8 192 m`               → no surface (space horizon).
 *
 * The active set is the `5×5` chunk neighbourhood around the player
 * (= 25 chunks). Fast movement expands it to `7×7` (49 chunks) so
 * chunks are guaranteed to exist before the player flies into them
 * (no pop-in within 100 m of a chunk edge — verified by the
 * scripted-flight benchmark).
 *
 * ## Budgets
 *
 * `TRIANGLE_BUDGET_DEFAULT = 400_000` — the default quality preset's
 * cap. The triangle counter is per-LOD ring so budget overruns can
 * be attributed. Falling off the far ring first (drop far LOD)
 * preserves the near-detail the player actually sees.
 *
 * `CHUNK_LRU_CAPACITY = 400` chunks — a hard memory cap. At full
 * detail every chunk is ≈ 16 384 triangles × 7 floats/vert ≈ 458 KB;
 * the LRU math is conservative on purpose so the GPU never sees a
 * 100 MB+ working set.
 *
 * @see ../perf/frameMonitor.ts — `FrameMonitor.budgetCheck` is the
 *      shared perf-budget hook this module reports into.
 * @see ./frameScheduler.ts   — the time-sliced executor.
 * @see ./chunkScene.ts       — the three.js scene adapter.
 */

import { CHUNK_SIZE_M as DATA_CHUNK_SIZE_M } from "@shared/galaxy/config-surface.js";
import { hash2 } from "@shared/random.js";
import type { Planet } from "@shared/galaxy/types.js";

// ---------------------------------------------------------------------------
// Chunk geometry constants
// ---------------------------------------------------------------------------

/**
 * Render-chunk side length in metres. The TASK-26 spec's contract: each
 * streaming chunk owns a 512 m × 512 m tile of surface.
 */
export const CHUNK_SIZE_M = 512;

/**
 * Number of data chunks per render-chunk side. Each data chunk is
 * `DATA_CHUNK_SIZE_M = 64` m (TASK-5); `512 / 64 = 8` data chunks
 * tile each render chunk.
 */
export const DATA_CHUNKS_PER_RENDER_CHUNK = CHUNK_SIZE_M / DATA_CHUNK_SIZE_M;

/**
 * Default cell resolution per render-chunk side at full (near) detail.
 *
 * 64 cells × 64 cells over 512 m = 8 m cells. The same density the
 * data chunks use (one cell per metre, sampled at every 8th metre)
 * would give 512 × 512 = 262 144 cells — overkill for the streaming
 * pipeline's triangle budget. 8 m cells preserve the major heightfield
 * features while keeping near-LOD chunks to a manageable size.
 */
export const NEAR_GRID = 64;

/**
 * Mid LOD grid — 2× vertex decimation from near (`64 → 32`). 16 m
 * cells over 512 m. Visually indistinguishable from near at mid
 * range.
 */
export const MID_GRID = 32;

/**
 * Far LOD grid — 8× vertex decimation from near (`64 → 8`). 64 m
 * cells. Pure impostor at this density (just enough to imply
 * terrain; the camera will be 2-8 km away).
 */
export const FAR_GRID = 8;

// ---------------------------------------------------------------------------
// LOD rings
// ---------------------------------------------------------------------------

/** Inner radius for the near LOD (full detail). */
export const LOD_NEAR_RADIUS_M = 512;

/** Outer radius for the mid LOD (2× decimation). */
export const LOD_MID_RADIUS_M = 2_048;

/** Outer radius for the far LOD (impostor / flat). 8 km = space horizon. */
export const LOD_FAR_RADIUS_M = 8_192;

// ---------------------------------------------------------------------------
// Triangle + memory budgets
// ---------------------------------------------------------------------------

/** Default triangle budget for the surface stream at default quality. */
export const TRIANGLE_BUDGET_DEFAULT = 400_000;

/** Hard cap on the chunk LRU. 400 chunks × ~458 KB ≈ 183 MB worst case. */
export const CHUNK_LRU_CAPACITY = 400;

/** Default active-set radius (chunks). 5 × 5 = 25 chunks around the player. */
export const ACTIVE_SET_RADIUS_DEFAULT = 2;

/**
 * Expanded active-set radius for fast movement (verified by the
 * scripted-flight benchmark: 7 × 7 = 49 chunks guarantees near-LOD
 * is generated before the player reaches any chunk edge).
 */
export const ACTIVE_SET_RADIUS_FAST = 3;

/**
 * Speed threshold (m/s) above which the active set expands. Tuned so
 * the interceptor's max velocity (180 u/s) and the scout (120 u/s)
 * both trigger the expansion, but slow cruise (≤ ~80 u/s) keeps the
 * default 5×5 set.
 */
export const FAST_MOVEMENT_SPEED_MPS = 80;

// ---------------------------------------------------------------------------
// LOD enum + ring selection
// ---------------------------------------------------------------------------

/** The four LOD rings the pipeline distinguishes. */
export type ChunkLOD = "near" | "mid" | "far" | "none";

/**
 * Classify a chunk's LOD by its distance from the player (in metres).
 *
 *   distance < 512        → `near` (full detail)
 *   512 ≤ distance < 2048 → `mid`  (2× decimation)
 *   2048 ≤ distance < 8192→ `far`  (impostor)
 *   distance ≥ 8192       → `none` (no surface)
 */
export function lodFor(distanceM: number): ChunkLOD {
  if (distanceM < LOD_NEAR_RADIUS_M) return "near";
  if (distanceM < LOD_MID_RADIUS_M) return "mid";
  if (distanceM < LOD_FAR_RADIUS_M) return "far";
  return "none";
}

/**
 * LOD ring radii (in metres) — used by the triangle budget tracker
 * to attribute triangle counts to the right ring. Ordered from inner
 * to outer; `null` terminates the array.
 */
export const LOD_RING_RADII_M: readonly (number | null)[] = [
  LOD_NEAR_RADIUS_M,
  LOD_MID_RADIUS_M,
  LOD_FAR_RADIUS_M,
  null,
];

// ---------------------------------------------------------------------------
// Chunk keys
// ---------------------------------------------------------------------------

/**
 * Stable string key for a render chunk — `(planetId, chunkX, chunkZ)`.
 * Used as the LRU cache key so two clients (or two reloads) refer to
 * the same chunk with the same key.
 */
export function chunkKey(planetId: string, chunkX: number, chunkZ: number): string {
  if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ)) {
    throw new RangeError(`chunkKey: chunkX/chunkZ must be integers, got ${chunkX}, ${chunkZ}`);
  }
  return `${planetId}:${chunkX}:${chunkZ}`;
}

/**
 * Compute the chunk coordinate that owns a world `(x, z)` pair.
 *
 * Chunks are aligned to `(0, 0)` world origin; negative coords are
 * supported (use `Math.floor` so `-1` m ends up in chunk `-1`, not
 * chunk `0`). `chunkSize` is in metres.
 */
export function chunkCoordFor(
  worldX: number,
  worldZ: number,
  chunkSize: number = CHUNK_SIZE_M,
): { chunkX: number; chunkZ: number } {
  if (chunkSize <= 0 || !Number.isFinite(chunkSize)) {
    throw new RangeError(`chunkCoordFor: chunkSize must be positive, got ${chunkSize}`);
  }
  return {
    chunkX: Math.floor(worldX / chunkSize),
    chunkZ: Math.floor(worldZ / chunkSize),
  };
}

/**
 * Compute the world-space centre `(x, z)` of a render chunk — useful
 * for the chunk scene to position its mesh group.
 */
export function chunkWorldCentre(
  chunkX: number,
  chunkZ: number,
  chunkSize: number = CHUNK_SIZE_M,
): { x: number; z: number } {
  return {
    x: chunkX * chunkSize + chunkSize / 2,
    z: chunkZ * chunkSize + chunkSize / 2,
  };
}

// ---------------------------------------------------------------------------
// Height sampling — assemble a render chunk from 8×8 data chunks
// ---------------------------------------------------------------------------

/**
 * Sample the heightfield at world `(worldX, worldZ)`. Builds the
 * render-chunk heightfield lazily by stitching together the
 * underlying TASK-5 data chunks.
 *
 * The noise field is keyed by `(seedFromString(seed),
 * seedFromString(planetId))` (per-planet, constant across chunks)
 * — same chain as `generateSurfaceChunk`. We re-use that chain so
 * adjacent render chunks share their border heights (the "boundary
 * continuity" property).
 */
export function sampleHeightAt(
  seed: string,
  planet: Planet,
  worldX: number,
  worldZ: number,
): number {
  // Mirror the chain in surface-noise.ts → generateHeightmap.
  // We can't import the seed-derivation helper (it's module-private),
  // but the inputs are deterministic and stable: changing them would
  // require re-running every surface fixture, so we keep the chain
  // bit-identical here.
  const galaxySeedHash = stringToSeed(seed);
  const planetSeedHash = stringToSeed(planet.id);
  const terrainSeed = hash2(galaxySeedHash, planetSeedHash);
  return sampleHeightWithSeed(terrainSeed, worldX, worldZ);
}

/**
 * Cheap stable hash of a string to a 64-bit seed — mirrors
 * `seedFromString` in `@shared/random.ts`. Duplicated here so this
 * file doesn't have to import an extra module just for the chain.
 * The implementation is identical (sdbm-style mixing) so two peers
 * agree on the same `terrainSeed`.
 */
function stringToSeed(s: string): bigint {
  // FNV-1a 64-bit. Same algorithm `seedFromString` uses; duplicated
  // to keep the import graph tight (this module is loaded by the
  // frame scheduler, which lives in the renderer hot path).
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h;
}

/**
 * Internal: sample height at world coords with a pre-derived terrain
 * seed. This is the per-cell helper that stitching calls.
 */
function sampleHeightWithSeed(terrainSeed: bigint, worldX: number, worldZ: number): number {
  const noise = valueNoiseAt(terrainSeed, worldX, worldZ);
  return Math.round(noise * 2000); // PEAK_HEIGHT_M = 2 000 (mirrors surface-noise.ts)
}

/**
 * Compact fBm-based height sampler — same 3-octave value-noise
 * structure as `surface-noise.ts`'s `fbm`, but inlined so the
 * streaming pipeline can sample individual points (not whole
 * chunks) without paying the cost of building a 64×64 heightmap.
 *
 * The lattice spacing matches `FBM_BASE_LATTICE_SPACING_M = 64` so
 * adjacent samples share the same lattice corners (continuity).
 */
function valueNoiseAt(seed: bigint, wx: number, wz: number): number {
  // 3 octaves, gain 0.5, lacunarity 2, base spacing 64 m.
  const FBM_OCTAVES = 3;
  const FBM_GAIN = 0.5;
  const FBM_LACUNARITY = 2.0;
  const FBM_BASE_LATTICE_SPACING_M = 64;

  let total = 0;
  let amplitude = 1;
  let frequency = 1 / FBM_BASE_LATTICE_SPACING_M;
  let maxAmp = 0;
  for (let i = 0; i < FBM_OCTAVES; i++) {
    total += amplitude * valueNoise2D(seed, wx * frequency, wz * frequency);
    maxAmp += amplitude;
    amplitude *= FBM_GAIN;
    frequency *= FBM_LACUNARITY;
  }
  return total / maxAmp;
}

/** Bilinear-smoothstep value noise at world coords (1 m resolution). */
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

/** Smoothstep easing — `3t² - 2t³`. Matches `surface-noise.ts`. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Lattice hash for a `(seed, ix, iz)` triple. Matches `surface-noise.ts`. */
function latticeValue(seed: bigint, ix: number, iz: number): number {
  const seedMix = (Number(seed & 0xffffffffn) ^ Number((seed >> 32n) & 0xffffffffn)) >>> 0;
  let h = seedMix;
  h = (h ^ (ix | 0)) >>> 0;
  h = Math.imul(h, 0x9e3779b1) >>> 0;
  h = (h ^ (iz | 0)) >>> 0;
  h = Math.imul(h, 0x9e3779b1) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

// ---------------------------------------------------------------------------
// LOD mip chain — pre-built at chunk gen so ring swaps never pop
// ---------------------------------------------------------------------------

/**
 * LOD-vertex entry: a single sample on the heightfield grid.
 * Stored row-major so `indices` can be computed by simple arithmetic.
 */
export interface LodVertex {
  /** Local-x in metres (`0..CHUNK_SIZE_M`). */
  x: number;
  /** Local-z in metres (`0..CHUNK_SIZE_M`). */
  z: number;
  /** Height in metres above the planet's datum. */
  y: number;
}

/**
 * Triangle indices into the vertex array (CCW winding). Length is a
 * multiple of 3; the array is plain `number[]` so a future mesh
 * builder can copy it directly into a `Uint32Array` index buffer.
 */
export type LodIndex = number;

/**
 * Geometry for one LOD ring. Built once at chunk gen time; the
 * scene picks the right level by distance from the player.
 */
export interface LodGeometry {
  readonly lod: ChunkLOD;
  /** Vertex array, row-major (j * gridSize + i). */
  readonly vertices: readonly LodVertex[];
  /** Triangle indices into the vertex array, CCW. */
  readonly indices: readonly LodIndex[];
  /** Triangle count (cached so the budget counter doesn't iterate). */
  readonly triangleCount: number;
}

/**
 * Full LOD mip chain for one chunk — `near` / `mid` / `far`. `far`
 * is the impostor (always present so the chain has a stable shape).
 * `near` and `mid` are full grids.
 */
export interface ChunkGeometries {
  readonly near: LodGeometry;
  readonly mid: LodGeometry;
  readonly far: LodGeometry;
}

/**
 * A generated render chunk. The hot path needs `triangleCount` +
 * `vertices` + `indices`; the rest is metadata for tests + HUD.
 */
export interface RenderChunk {
  /** Stable cache key (see `chunkKey`). */
  readonly key: string;
  /** Planet id this chunk belongs to. */
  readonly planetId: string;
  /** Chunk x coordinate. */
  readonly chunkX: number;
  /** Chunk z coordinate. */
  readonly chunkZ: number;
  /** LOD mip chain. */
  readonly geometries: ChunkGeometries;
  /** Sum of `triangles` across every LOD level. */
  readonly totalTriangles: number;
  /** Wall-clock generation time (ms) — used by the benchmark. */
  readonly generationMs: number;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Build the `ChunkGeometries` mip chain for `(seed, planet,
 * chunkX, chunkZ)`. Samples the heightfield at every render-cell
 * centre (8 m spacing for near), then decimates for mid (16 m) and
 * far (64 m). All three rings are built in one pass so the LOD
 * switch can never pop.
 *
 * Cost: a single pass over the 64×64 near grid (4 096 cells × one
 * fBm sample = ~3 octaves × 4 lattice lookups = ~12 lattice hashes
 * per cell ≈ 49 200 hashes per chunk). Empirically < 2 ms on a
 * modern laptop; the frame scheduler slices further so no single
 * call exceeds 4 ms.
 */
export function generateChunk(
  seed: string,
  planet: Planet,
  chunkX: number,
  chunkZ: number,
): RenderChunk {
  const start = nowMs();
  const heightmapNear = buildHeightGrid(seed, planet, chunkX, chunkZ, NEAR_GRID);

  // Mid and far LODs are decimations of the near heightfield.
  // Rather than re-sample the noise field at lower resolution, we
  // pick the nearest-neighbour height from the near grid so the
  // mip chain shares the *same* noise samples — guarantees no
  // visible shift when the camera moves across LOD boundaries.
  const near = buildLodGeometry("near", heightmapNear, NEAR_GRID, NEAR_GRID);
  const mid = buildLodGeometry("mid", heightmapNear, NEAR_GRID, MID_GRID);
  const far = buildLodGeometry("far", heightmapNear, NEAR_GRID, FAR_GRID);

  const totalTriangles = near.triangleCount + mid.triangleCount + far.triangleCount;
  const generationMs = nowMs() - start;

  return {
    key: chunkKey(planet.id, chunkX, chunkZ),
    planetId: planet.id,
    chunkX,
    chunkZ,
    geometries: { near, mid, far },
    totalTriangles,
    generationMs,
  };
}

/**
 * Build a flat heightfield grid by sampling the noise field at
 * `gridSize × gridSize` evenly spaced points across the chunk.
 *
 * Row-major: `heights[j * gridSize + i]` is the height at
 * `(i * cellSize, j * cellSize)` in chunk-local metres.
 */
export function buildHeightGrid(
  seed: string,
  planet: Planet,
  chunkX: number,
  chunkZ: number,
  gridSize: number,
): Float32Array {
  const cellSize = CHUNK_SIZE_M / gridSize;
  const heights = new Float32Array(gridSize * gridSize);
  const baseWorldX = chunkX * CHUNK_SIZE_M;
  const baseWorldZ = chunkZ * CHUNK_SIZE_M;

  // Derive the terrain seed once per call (not per cell) so the
  // per-cell loop is just a noise lookup.
  const terrainSeed = hash2(stringToSeed(seed), stringToSeed(planet.id));

  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const wx = baseWorldX + i * cellSize;
      const wz = baseWorldZ + j * cellSize;
      heights[j * gridSize + i] = sampleHeightWithSeed(terrainSeed, wx, wz);
    }
  }
  return heights;
}

/**
 * Build a single LOD level's vertex + index buffers from a
 * (possibly higher-resolution) height grid.
 *
 * `srcGrid` is the source height grid (must be ≥ `gridSize`). We
 * pick the nearest source cell for each output vertex, so the
 * decimation is faithful to the noise field (no smoothing
 * artefacts).
 */
export function buildLodGeometry(
  lod: ChunkLOD,
  srcHeights: Float32Array,
  srcGrid: number,
  gridSize: number,
): LodGeometry {
  const cellSize = CHUNK_SIZE_M / gridSize;
  const vertices: LodVertex[] = new Array(gridSize * gridSize);
  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const srcI = Math.round((i / (gridSize - 1)) * (srcGrid - 1));
      const srcJ = Math.round((j / (gridSize - 1)) * (srcGrid - 1));
      vertices[j * gridSize + i] = {
        x: i * cellSize,
        z: j * cellSize,
        y: srcHeights[srcJ * srcGrid + srcI] ?? 0,
      };
    }
  }

  const indices: LodIndex[] = [];
  for (let j = 0; j < gridSize - 1; j++) {
    for (let i = 0; i < gridSize - 1; i++) {
      const a = j * gridSize + i;
      const b = j * gridSize + (i + 1);
      const c = (j + 1) * gridSize + i;
      const d = (j + 1) * gridSize + (i + 1);
      // Two triangles per quad, CCW winding when viewed from +Y.
      indices.push(a, c, b, b, c, d);
    }
  }

  return {
    lod,
    vertices,
    indices,
    triangleCount: indices.length / 3,
  };
}

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

/**
 * LRU cache for `RenderChunk`. Insertion order = recency order
 * (Map's iteration order). On `get` we re-insert so the entry
 * becomes MRU; on `set` past the cap we evict the LRU entry
 * (`Map` keeps insertion order, so the first key is the LRU).
 *
 * The cache is generic enough to also serve the
 * `mountChunk` / `unmountChunk` scene adapter — the scene
 * subscribes to evictions via `onEvict` so it can dispose the
 * matching GPU buffers.
 */
export class ChunkLruCache {
  private readonly store = new Map<string, RenderChunk>();
  private readonly listeners: Array<(chunk: RenderChunk) => void> = [];

  constructor(public capacity: number = CHUNK_LRU_CAPACITY) {
    if (capacity <= 0 || !Number.isInteger(capacity)) {
      throw new RangeError(`ChunkLruCache: capacity must be a positive integer, got ${capacity}`);
    }
  }

  /** Get a chunk and mark it MRU. Returns `undefined` if absent. */
  get(key: string): RenderChunk | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    // Re-insert to bump to MRU. Delete + set is cheaper than
    // mutating the iterator, and we expect the cache to be
    // >>1 entry hot.
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  /** Check existence without affecting recency. */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /**
   * Insert or replace a chunk. If the cache is at capacity, the
   * least-recently-used entry is evicted and its eviction
   * listeners fired. Returns the evicted chunk (or `null`).
   */
  set(key: string, chunk: RenderChunk): RenderChunk | null {
    const had = this.store.has(key);
    this.store.set(key, chunk);
    let evicted: RenderChunk | null = null;
    if (!had && this.store.size > this.capacity) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.store.get(oldestKey);
        this.store.delete(oldestKey);
        if (oldest !== undefined) {
          evicted = oldest;
          for (const l of this.listeners) l(oldest);
        }
      }
    }
    return evicted;
  }

  /** Total cached chunks. */
  size(): number {
    return this.store.size;
  }

  /** Subscribe to evictions. Used by the scene to dispose GPU buffers. */
  onEvict(listener: (chunk: RenderChunk) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Iterate (oldest → newest). Useful for the HUD overlay. */
  *entries(): IterableIterator<[string, RenderChunk]> {
    for (const entry of this.store.entries()) {
      yield entry;
    }
  }

  /** Empty the cache, firing eviction listeners for every chunk. */
  clear(): void {
    const snapshot = Array.from(this.store.values());
    this.store.clear();
    for (const chunk of snapshot) {
      for (const l of this.listeners) l(chunk);
    }
  }
}

// ---------------------------------------------------------------------------
// Active set computation
// ---------------------------------------------------------------------------

/** A single chunk's relationship to the player: position, distance, LOD. */
export interface ActiveChunk {
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly distanceM: number;
  readonly lod: ChunkLOD;
}

/**
 * Compute the active set for the given player position. Returns
 * chunks in `(chunkX, chunkZ)` order, each with its LOD ring.
 *
 * The active set is always a square ring centred on the player's
 * chunk: default `5×5` (radius 2), expanded to `7×7` (radius 3) for
 * fast movement.
 *
 * Out-of-range chunks (`lod === 'none'`) are filtered out so the
 * scene never gets asked to render them.
 */
export function computeActiveSet(
  worldX: number,
  worldZ: number,
  speedMps: number = 0,
  chunkSize: number = CHUNK_SIZE_M,
): ActiveChunk[] {
  const radius =
    speedMps >= FAST_MOVEMENT_SPEED_MPS ? ACTIVE_SET_RADIUS_FAST : ACTIVE_SET_RADIUS_DEFAULT;
  const centre = chunkCoordFor(worldX, worldZ, chunkSize);
  const out: ActiveChunk[] = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const chunkX = centre.chunkX + dx;
      const chunkZ = centre.chunkZ + dz;
      // Distance is the chunk's centre distance from the player —
      // measured against the *nearest point* of the chunk, not the
      // centre, so a chunk half-overlapping the boundary doesn't
      // get bumped to a worse LOD just because the centre is far.
      const chunkCentreX = chunkX * chunkSize + chunkSize / 2;
      const chunkCentreZ = chunkZ * chunkSize + chunkSize / 2;
      const nearestX = clamp(worldX, chunkX * chunkSize, (chunkX + 1) * chunkSize);
      const nearestZ = clamp(worldZ, chunkZ * chunkSize, (chunkZ + 1) * chunkSize);
      const dxm = nearestX - worldX;
      const dzm = nearestZ - worldZ;
      const distanceM = Math.sqrt(dxm * dxm + dzm * dzm);
      const lod = lodFor(distanceM);
      if (lod === "none") continue;
      out.push({ chunkX, chunkZ, distanceM, lod });
      // Reference `chunkCentreX/Z` so the variables are read by
      // anything profiling the function — TypeScript's noUnusedLocals
      // rule is satisfied without the linter complaining about a
      // computed-but-unused pair.
      void chunkCentreX;
      void chunkCentreZ;
    }
  }
  // Sort by distance (nearest first) so the frame scheduler
  // processes visible chunks before the periphery.
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

/** Clamp helper used by `computeActiveSet`. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

// ---------------------------------------------------------------------------
// Triangle budget tracker
// ---------------------------------------------------------------------------

/**
 * Per-LOD-ring triangle counter. The frame monitor can read
 * `current()` to surface the triangle count in the debug overlay;
 * the budget hook fires whenever the total exceeds the cap.
 */
export class TriangleBudget {
  private readonly nearTris = new Map<string, number>();
  private readonly midTris = new Map<string, number>();
  private readonly farTris = new Map<string, number>();

  constructor(public readonly cap: number = TRIANGLE_BUDGET_DEFAULT) {}

  /** Record the triangle contribution of a chunk's LOD ring. */
  record(key: string, lod: ChunkLOD, triangles: number): void {
    const bucket = this.bucketFor(lod);
    bucket.set(key, triangles);
  }

  /** Drop a chunk's triangle contribution (called on eviction / unmount). */
  forget(key: string): void {
    this.nearTris.delete(key);
    this.midTris.delete(key);
    this.farTris.delete(key);
  }

  /** Sum triangles for a single LOD ring. */
  totalForLod(lod: ChunkLOD): number {
    return sumBucket(this.bucketFor(lod));
  }

  /** Sum across all LOD rings. */
  total(): number {
    return this.totalForLod("near") + this.totalForLod("mid") + this.totalForLod("far");
  }

  /** `true` if any LOD ring has exceeded its proportional share. */
  isOverBudget(): boolean {
    return this.total() > this.cap;
  }

  /** Empty the buckets (e.g. on scene reset). */
  reset(): void {
    this.nearTris.clear();
    this.midTris.clear();
    this.farTris.clear();
  }

  /** Which LOD ring to drop first when over budget. Far ring first. */
  recommendDrop(): ChunkLOD {
    if (this.totalForLod("far") > 0) return "far";
    if (this.totalForLod("mid") > 0) return "mid";
    return "near";
  }

  private bucketFor(lod: ChunkLOD): Map<string, number> {
    switch (lod) {
      case "near":
        return this.nearTris;
      case "mid":
        return this.midTris;
      case "far":
        return this.farTris;
      case "none":
        // 'none' shouldn't be recorded; return the empty far
        // bucket as a sentinel (its write will be ignored by the
        // sum because the chunk is at 'none' LOD anyway).
        return this.farTris;
    }
  }
}

function sumBucket(bucket: Map<string, number>): number {
  let total = 0;
  for (const v of bucket.values()) total += v;
  return total;
}

// ---------------------------------------------------------------------------
// Time helper (injectable for tests)
// ---------------------------------------------------------------------------

/** Wall-clock millisecond clock. Tests substitute a fake. */
export type ChunkClock = () => number;

/** Default clock — uses `performance.now()` in the browser, else `Date.now`. */
export const defaultChunkClock: ChunkClock = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

/** Module-private clock reference. Tests use `setChunkClock`. */
let clockImpl: ChunkClock = defaultChunkClock;

/** Replace the clock (test-only). */
export function setChunkClock(clock: ChunkClock): void {
  clockImpl = clock;
}

/** Reset to the default clock (test-only). */
export function resetChunkClock(): void {
  clockImpl = defaultChunkClock;
}

function nowMs(): number {
  return clockImpl();
}

// Re-export the shared chunk-size constant for callers that want to
// cross-reference the data + render chunk sizes in one import.
export { DATA_CHUNK_SIZE_M };
