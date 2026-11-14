import { Rng, hash2 } from '../random.ts';
import { chunkInChart, type Hemisphere } from './chart.ts';
import { placeNodes, placePads } from './placement.ts';
import {
  CHUNK_SAMPLES,
  CHUNK_SIZE_M,
  MAX_CHUNK_COORD,
  createSurfaceField,
  planetSurfaceSeed,
  samplePosition,
} from './terrain.ts';
import type { Planet, SurfaceChunk } from './types.ts';

/** Throws unless `value` is an integer chunk coordinate within the supported range. */
function checkChunkCoord(name: string, value: number): void {
  if (!Number.isInteger(value) || Math.abs(value) > MAX_CHUNK_COORD) {
    throw new RangeError(
      `${name} must be an integer with |value| <= ${MAX_CHUNK_COORD}, got ${value}`,
    );
  }
}

/**
 * Derives a surface chunk purely from (seed, planet, hemisphere, chunkX, chunkZ): heightmap
 * samples of the terrain field, the biome at the chunk centre, resource nodes and landing pads.
 * Any client or the server reconstructs identical chunks without stored data. Chunk, node and
 * pad coordinates are flat metres of that hemisphere's chart (chart.ts); a chunk belongs to a
 * chart only while its centre is within the equator (r <= 1) - beyond it the other chart owns
 * the ground. Every discrete decision for a chunk is evaluated through its own chart only.
 * @throws RangeError for gas giants, invalid chunk coordinates, or a chunk outside its chart.
 */
export function generateSurfaceChunk(
  seed: string,
  planet: Planet,
  chunkX: number,
  chunkZ: number,
  hemisphere: Hemisphere = 'n',
): SurfaceChunk {
  checkChunkCoord('chunkX', chunkX);
  checkChunkCoord('chunkZ', chunkZ);
  if (!chunkInChart(planet.simRadius, chunkX, chunkZ, CHUNK_SIZE_M)) {
    throw new RangeError(`chunk (${chunkX}, ${chunkZ}) is outside the ${hemisphere} chart`);
  }
  const field = createSurfaceField(seed, planet, hemisphere);

  const heightmap: number[] = new Array<number>(CHUNK_SAMPLES * CHUNK_SAMPLES);
  for (let j = 0; j < CHUNK_SAMPLES; j++) {
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      const { x, z } = samplePosition(chunkX, chunkZ, i, j);
      heightmap[j * CHUNK_SAMPLES + i] = field.heightUnitsAt(x, z);
    }
  }

  const x0 = chunkX * CHUNK_SIZE_M;
  const z0 = chunkZ * CHUNK_SIZE_M;
  const stretch = 1 / field.scaleAt(x0 + CHUNK_SIZE_M / 2, z0 + CHUNK_SIZE_M / 2);
  const origin = { x0, z0, stretch };
  const planetSeed = planetSurfaceSeed(seed, planet, hemisphere);
  const chunkSeed = hash2(hash2(planetSeed, BigInt(chunkX)), BigInt(chunkZ));
  const rng = new Rng(chunkSeed);

  const landingPads = placePads(
    rng,
    chunkSeed,
    origin,
    field,
    planet,
    hemisphere === 'n' && chunkX === 0 && chunkZ === 0,
  );
  const resourceNodes = placeNodes(rng, chunkSeed, origin, field, planet, landingPads);
  const biome = field.biomeAt(origin.x0 + CHUNK_SIZE_M / 2, origin.z0 + CHUNK_SIZE_M / 2);

  return { hemisphere, chunkX, chunkZ, heightmap, biome, resourceNodes, landingPads };
}
