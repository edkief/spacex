/**
 * Surface chunk generator configuration.
 *
 * Lives in its own file (rather than appending to `config.ts` or
 * `config-system.ts`) so the import graph for the rest of `shared/galaxy`
 * is unchanged — `stars.ts` and `system.ts` only pull what they need.
 *
 * Every constant here is exercised by the test suite. Most tweaks will
 * invalidate the golden fixture in
 * `__fixtures__/surface-dev-seed-star0-planet0-chunk00.json`, the same
 * way a tweak to `PLANET_CLASS_WEIGHTS` invalidates the system fixture.
 */

import type { Biome } from "./types.js";

// ---------------------------------------------------------------------------
// Chunk geometry
// ---------------------------------------------------------------------------

/** Cells per chunk side. Spec: 64. */
export const CHUNK_SIZE_CELLS = 64;

/** Total cells per chunk. 64 * 64 = 4096. */
export const CELLS_PER_CHUNK = CHUNK_SIZE_CELLS * CHUNK_SIZE_CELLS;

/** Cell size in metres — each heightmap cell is 1 m × 1 m. */
export const CELL_SIZE_M = 1;

/** Chunk side length in metres. 64 cells * 1 m = 64 m. */
export const CHUNK_SIZE_M = CHUNK_SIZE_CELLS * CELL_SIZE_M;

// ---------------------------------------------------------------------------
// Heightmap
// ---------------------------------------------------------------------------

/**
 * Peak elevation in metres.
 *
 * The fBm field produces values in roughly [0, 1]; we scale by this and
 * round to integer metres. 2 000 m is generous (Mt. Everest is ~8.8 km,
 * most gameplay happens below 1 km) but leaves plenty of headroom for
 * the Uint16 range (~65 k), which is the spec's wire-type requirement.
 */
export const PEAK_HEIGHT_M = 2_000;

/** Minimum height (used for clamping; the fBm floor is 0). */
export const MIN_HEIGHT_M = 0;

// ---------------------------------------------------------------------------
// fBm (height noise)
// ---------------------------------------------------------------------------

/** Number of octaves for the height fBm. */
export const FBM_OCTAVES = 3;

/** Amplitude ratio per octave. 0.5 is the textbook fBm "gain" choice. */
export const FBM_GAIN = 0.5;

/** Frequency ratio per octave (lacunarity). 2.0 is standard. */
export const FBM_LACUNARITY = 2.0;

/**
 * Lattice spacing (metres) for the lowest-frequency octave. Each
 * successive octave divides by `FBM_LACUNARITY`, so with OCTAVES=3 the
 * octaves live at 64 m, 32 m, and 16 m.
 *
 * Why 64 m (= chunk size)? Two reasons:
 *
 *   1. Boundary continuity: octave 0's lattice point for chunk (cx, cz)
 *      is at world `(cx*64, cz*64)`; the chunk's interior samples are
 *      smoothstep interpolations of the same 4 lattice corners as the
 *      adjacent chunks. The only discontinuities live at the smaller
 *      octaves' lattice boundaries, which are 16 m apart — a quarter of
 *      the chunk size, well inside the visual noise floor.
 *   2. Within-chunk detail: the 16 m / 32 m octaves add enough small-
 *      scale variation for the heightmap to look textured, not flat.
 *      Coarser values (e.g. 256 m base) would erase this.
 */
export const FBM_BASE_LATTICE_SPACING_M = 64;

// ---------------------------------------------------------------------------
// Moisture / latitude noise (biome classification inputs)
// ---------------------------------------------------------------------------

/** Octaves for the moisture channel (decorrelated from the height noise by a hash discriminator). */
export const MOISTURE_FBM_OCTAVES = 3;

/** Gain for the moisture fBm. */
export const MOISTURE_FBM_GAIN = 0.5;

/** Lacunarity for the moisture fBm. */
export const MOISTURE_FBM_LACUNARITY = 2.0;

/** Lattice spacing for the moisture channel's highest octave (metres). */
export const MOISTURE_FBM_BASE_LATTICE_SPACING_M = 8;

/** Octaves for the latitude / "polar" channel. */
export const LATITUDE_FBM_OCTAVES = 2;

/** Gain for the latitude fBm. */
export const LATITUDE_FBM_GAIN = 0.5;

/** Lacunarity for the latitude fBm. */
export const LATITUDE_FBM_LACUNARITY = 2.0;

/** Lattice spacing for the latitude channel (metres). Coarse on purpose. */
export const LATITUDE_FBM_BASE_LATTICE_SPACING_M = 64;

// ---------------------------------------------------------------------------
// Biome classification thresholds
// ---------------------------------------------------------------------------

/**
 * Frozen-biome latitude threshold for normal planets. Latitudes above
 * this become `frozen` regardless of moisture.
 */
export const FROZEN_LATITUDE_THRESHOLD = 0.7;

/**
 * Frozen-biome latitude threshold for ice-class planets. Lower than the
 * default because ice worlds are cold everywhere, not just at the poles.
 */
export const FROZEN_LATITUDE_THRESHOLD_ICE = 0.5;

/** Wetland-biome moisture threshold (the chunk must *also* be low-elevation). */
export const WETLAND_MOISTURE_THRESHOLD = 0.65;

/** Maximum normalised elevation for a chunk to qualify as wetland. */
export const WETLAND_MAX_ELEVATION = 0.3;

/** Minimum normalised gradient for a chunk to qualify as canyon. */
export const CANYON_MIN_GRADIENT = 0.3;

/** Minimum normalised elevation for a chunk to qualify as canyon. */
export const CANYON_MIN_ELEVATION = 0.3;

/** Minimum normalised elevation for a chunk to qualify as rock. */
export const ROCK_MIN_ELEVATION = 0.55;

// ---------------------------------------------------------------------------
// Resource nodes
// ---------------------------------------------------------------------------

/** Lower bound for the seeded per-chunk node count (inclusive). */
export const MIN_NODES_PER_CHUNK = 1;

/** Upper bound for the seeded per-chunk node count (inclusive). */
export const MAX_NODES_PER_CHUNK = 4;

/** Minimum base quantity per node (inclusive). */
export const MIN_NODE_QUANTITY = 50;

/** Maximum base quantity per node (exclusive of the +1 to make integer arithmetic clean). */
export const MAX_NODE_QUANTITY_EXCLUSIVE = 201;

/** Minimum spacing between two resource nodes in the same chunk (metres). */
export const NODE_MIN_SPACING_M = 4;

/**
 * Maximum placement attempts per node before giving up. Set so that even
 * with MAX_NODES_PER_CHUNK=4 and NODE_MIN_SPACING_M=4 (leaving a usable
 * 60×60 grid for spacing), rejection sampling finishes with overwhelming
 * probability inside the budget.
 */
export const NODE_PLACEMENT_MAX_ATTEMPTS = 50;

// ---------------------------------------------------------------------------
// Landing pads
// ---------------------------------------------------------------------------

/** Per-chunk pad probability (excluding the chunk-(0,0) landable override). */
export const PAD_PROBABILITY = 0.25;

/**
 * Block size (cells) used by the "find flat spot" pass. We scan the
 * chunk in `BLOCK_SIZE_CELLS × BLOCK_SIZE_CELLS` blocks and pick the
 * block with the smallest `max - min` height as the pad anchor. Larger
 * blocks give flatter landing areas; smaller blocks give more choices.
 */
export const PAD_BLOCK_SIZE_CELLS = 4;

/** Minimum pad-to-node distance (metres). 20 m = 20 cells. */
export const NODE_PAD_MIN_DISTANCE_M = 20;

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

/**
 * Width of the hex-encoded id (16 chars == 64 bits). Same as
 * `ID_HEX_CHARS` in `config-system.ts`; duplicated here to keep the
 * import graph tight (no cross-file config dependency).
 */
export const ID_HEX_CHARS = 16;

// ---------------------------------------------------------------------------
// Biome cross-reference (used by tests + dev tooling)
// ---------------------------------------------------------------------------

/** All biome values in display order. */
export const ALL_BIOMES: readonly Biome[] = [
  "plains",
  "rock",
  "canyon",
  "frozen",
  "wetland",
] as const;
