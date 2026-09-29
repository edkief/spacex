/**
 * Deterministic 2D value noise + fBm built on the shared hash primitives.
 *
 * The lattice lives in *world* cell coordinates (not chunk-local): a lattice
 * index is floor(worldCoord / LATTICE_CELLS), so two chunks sharing a border
 * sample exactly the same lattice points and the heightfield is continuous
 * across chunk edges by construction.
 *
 * Lattice values are 24-bit floats derived from hash2 (same precision class
 * as Rng.nextF64); that is plenty for terrain and keeps Node/browser parity.
 *
 * NOTE: lattice indices are masked to 32 bits when hashed, so the world
 * lattice is exact for |worldCoord| < ~2^31 cells (≈ 32k chunks) — far beyond
 * any reachable sector.
 */

import { hash2 } from '../random.js';

/** Lattice spacing in world cells. One value-noise cell spans this many grid cells. */
export const LATTICE_CELLS = 32;

/** fBm octave count (4-5 per spec; 5 gives fine detail at 10 m cells). */
export const OCTAVES = 5;

/** fBm persistence (amplitude halving per octave). */
export const FBM_GAIN = 0.5;

const U32_TO_F64 = 0x100000000;

/** Hermite smoothstep on [0, 1]. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A memoized noise channel. The same (channelSeed) always yields the same
 * field; the memo cache is per-chunk so repeated lookups during placement
 * (pads, nodes, biome) are cheap.
 */
export function makeNoiseChannel(channelSeed: bigint) {
  const memo = new Map<string, number>();

  /** Pseudo-random lattice value in [0, 1) at lattice cell (ix, iz). */
  const latticeValue = (ix: number, iz: number): number => {
    const key = ix + ',' + iz;
    let v = memo.get(key);
    if (v === undefined) {
      const k = ((BigInt(ix) & 0xffffffffn) << 32n) | (BigInt(iz) & 0xffffffffn);
      v = Number(hash2(channelSeed, k) & 0xffffffffn) / U32_TO_F64;
      memo.set(key, v);
    }
    return v;
  };

  /**
   * Value noise at fractional world-lattice coords: bilinear smoothstep
   * interpolation of the four surrounding lattice values.
   */
  const valueNoise = (px: number, pz: number): number => {
    const ix = Math.floor(px);
    const iz = Math.floor(pz);
    const sx = smooth(px - ix);
    const sz = smooth(pz - iz);
    const top = lerp(latticeValue(ix, iz), latticeValue(ix + 1, iz), sx);
    const bottom = lerp(latticeValue(ix, iz + 1), latticeValue(ix + 1, iz + 1), sx);
    return lerp(top, bottom, sz);
  };

  /**
   * fBm in [0, 1) sampled at world *cell* coordinates (LATTICE_CELLS apart
   * at the base octave, doubling frequency each of the OCTAVES octaves).
   */
  const fbm01 = (worldX: number, worldZ: number): number => {
    let sum = 0;
    let norm = 0;
    let amp = 1 - FBM_GAIN;
    for (let o = 0; o < OCTAVES; o++) {
      const f = 2 ** o;
      sum += amp * valueNoise((worldX * f) / LATTICE_CELLS, (worldZ * f) / LATTICE_CELLS);
      norm += amp;
      amp *= FBM_GAIN;
    }
    return sum / norm;
  };

  return { valueNoise, fbm01 };
}
