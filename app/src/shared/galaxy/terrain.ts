import { hash2, seedFromString } from '../random.ts';
import { chartRadiusSq, chartScale, type Hemisphere } from './chart.ts';
import { fbm3D } from './noise.ts';
import type { Biome, Planet, PlanetClass } from './types.ts';

/** Chunk edge length in metres. */
export const CHUNK_SIZE_M = 256;
/** Heightmap samples per chunk edge. */
export const CHUNK_SAMPLES = 64;
/** Spacing between neighbouring samples in metres (CHUNK_SIZE_M / CHUNK_SAMPLES). */
export const SAMPLE_STEP_M = 4;
/** Stored heightmap integers per metre (decimetres); 65535 units cover 0..6553.5 m. */
export const HEIGHT_UNITS_PER_M = 10;
export const MAX_HEIGHT_UNITS = 65535;
/** Largest |chunk coordinate| accepted, keeping world coordinates exact in 32-bit lattice math. */
export const MAX_CHUNK_COORD = 1 << 20;
const MAX_WORLD_M = MAX_CHUNK_COORD * CHUNK_SIZE_M;

const SOUTH_SALT = 0x736f757468n;
const HEIGHT_SALT = 0x6865696768n;
const MOISTURE_SALT = 0x6d6f697374n;
const HEIGHT_LATTICE_M = 512;
const HEIGHT_OCTAVES = 5;
const MOISTURE_LATTICE_M = 1024;
const MOISTURE_OCTAVES = 3;

/** Terrain relief amplitude in metres per planet class. */
const CLASS_AMPLITUDE_M: Readonly<Record<PlanetClass, number>> = {
  terran: 220,
  rocky: 320,
  ocean: 60,
  ice: 180,
  gas: 0,
};

/** Clamps to [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Boosts contrast around the mid-point, since fBm of value noise clusters near 0.5. */
function stretch(value: number): number {
  return clamp01(0.5 + (value - 0.5) * 1.7);
}

/** Maps normalised height, moisture and planet class to a biome. */
export function biomeFor(planetClass: PlanetClass, height01: number, moisture: number): Biome {
  switch (planetClass) {
    case 'ice':
      return height01 > 0.7 ? 'rock' : 'frozen';
    case 'ocean':
      return height01 > 0.75 ? 'rock' : moisture > 0.45 ? 'wetland' : 'plains';
    case 'rocky':
      if (height01 > 0.55) return 'rock';
      return moisture < 0.5 && height01 < 0.35 ? 'canyon' : 'plains';
    default:
      if (height01 > 0.68) return 'rock';
      if (moisture > 0.6 && height01 < 0.55) return 'wetland';
      return moisture < 0.4 && height01 < 0.4 ? 'canyon' : 'plains';
  }
}

/**
 * Pure terrain sampler for one chart of a planet; build once with `createSurfaceField`, then
 * sample freely. Coordinates are flat chart metres (see chart.ts); heights are true metres.
 */
export interface SurfaceField {
  readonly hemisphere: Hemisphere;
  /** Local chart scale at a flat position: true metres per flat metre (1 at the pole). */
  scaleAt(worldX: number, worldZ: number): number;
  /** Exact terrain height in metres at a world position. Single source of truth for height. */
  heightAt(worldX: number, worldZ: number): number;
  /** Height quantised to heightmap units (integers 0..65535). */
  heightUnitsAt(worldX: number, worldZ: number): number;
  /** Moisture channel in [0, 1] at a world position. */
  moistureAt(worldX: number, worldZ: number): number;
  /** Biome at a world position, from the same height and moisture channels. */
  biomeAt(worldX: number, worldZ: number): Biome;
}

/** Throws unless `value` is a finite world coordinate the 32-bit lattice can address exactly. */
function checkWorld(value: number): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_WORLD_M) {
    throw new RangeError(`world coordinate out of range: ${value}`);
  }
}

/** The planet's terrain seed; the south chart's chunk content derives from a salted copy. */
export function planetSurfaceSeed(seed: string, planet: Planet, hemisphere: Hemisphere): bigint {
  const planetSeed = hash2(seedFromString(seed), BigInt(`0x${planet.id}`));
  return hemisphere === 'n' ? planetSeed : hash2(planetSeed, SOUTH_SALT);
}

/**
 * Builds the terrain sampler for one chart of a planet. Terrain is a function of the point on
 * the sphere: a flat position maps to a unit direction through the chart's algebraic inverse,
 * and 3D noise is sampled at that point of the datum sphere (metres from the planet centre). So
 * both charts see the same continuous terrain, with no seam, pole or anisotropic stretch. The
 * only BigInt work (seed derivation) happens here; sampling is 32-bit Number math.
 * @throws RangeError for gas giants, which have no surface.
 */
export function createSurfaceField(
  seed: string,
  planet: Planet,
  hemisphere: Hemisphere = 'n',
): SurfaceField {
  if (planet.class === 'gas') throw new RangeError('gas giants have no surface');
  const planetSeed = planetSurfaceSeed(seed, planet, 'n');
  const heightSeed = Number(BigInt.asUintN(32, hash2(planetSeed, HEIGHT_SALT)));
  const moistureSeed = Number(BigInt.asUintN(32, hash2(planetSeed, MOISTURE_SALT)));
  const amplitude = CLASS_AMPLITUDE_M[planet.class] * (0.8 + planet.radiusKm / 20000);
  const radius = planet.simRadius;

  const sign = hemisphere === 'n' ? 1 : -1;
  // Inlined `chartToUnit` (same arithmetic, no allocation): flat position -> datum point.
  const sample = (noiseSeed: number, lattice: number, octaves: number, x: number, z: number) => {
    checkWorld(x);
    checkWorld(z);
    const a = x / (2 * radius);
    const b = z / (2 * radius);
    const q = 1 + a * a + b * b;
    const px = radius * ((2 * a) / q);
    const py = radius * ((sign * (2 - q)) / q);
    const pz = radius * ((sign * 2 * b) / q);
    return stretch(fbm3D(noiseSeed, px, py, pz, lattice, octaves));
  };
  const height01 = (x: number, z: number): number =>
    sample(heightSeed, HEIGHT_LATTICE_M, HEIGHT_OCTAVES, x, z);
  const heightAt = (x: number, z: number): number => amplitude * height01(x, z);
  const moistureAt = (x: number, z: number): number =>
    sample(moistureSeed, MOISTURE_LATTICE_M, MOISTURE_OCTAVES, x, z);

  return {
    hemisphere,
    scaleAt: (x, z) => chartScale(chartRadiusSq(radius, x, z)),
    heightAt,
    heightUnitsAt: (x, z) =>
      Math.min(MAX_HEIGHT_UNITS, Math.round(heightAt(x, z) * HEIGHT_UNITS_PER_M)),
    moistureAt,
    biomeAt: (x, z) => biomeFor(planet.class, height01(x, z), moistureAt(x, z)),
  };
}

/**
 * Exact terrain height in metres at a flat chart position: the single source of truth that chunk
 * heightmaps merely sample. Convenient for one-off queries; use `createSurfaceField` in loops.
 */
export function surfaceHeightAt(
  seed: string,
  planet: Planet,
  worldX: number,
  worldZ: number,
  hemisphere: Hemisphere = 'n',
): number {
  return createSurfaceField(seed, planet, hemisphere).heightAt(worldX, worldZ);
}

/**
 * Flat chart position (metres) of heightmap sample `(i, j)` of chunk `(chunkX, chunkZ)`:
 * `x = chunkX * 256 + i * 4`, `z = chunkZ * 256 + j * 4`. Edges are adjacent, not shared: the
 * last column (i = 63) sits one 4 m step before the next chunk's first column (i = 0).
 */
export function samplePosition(
  chunkX: number,
  chunkZ: number,
  i: number,
  j: number,
): { x: number; z: number } {
  return {
    x: chunkX * CHUNK_SIZE_M + i * SAMPLE_STEP_M,
    z: chunkZ * CHUNK_SIZE_M + j * SAMPLE_STEP_M,
  };
}
