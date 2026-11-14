import { Rng, hash2, seedFromString } from '../random.ts';
import { placeNodes, placePads } from './placement.ts';
import {
  CHUNK_SAMPLES,
  CHUNK_SIZE_M,
  MAX_CHUNK_COORD,
  createSurfaceField,
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
 * Derives a surface chunk purely from (seed, planet, chunkX, chunkZ): heightmap samples of the
 * world-space terrain field, the biome at the chunk centre, resource nodes and landing pads.
 * Any client or the server reconstructs identical chunks without stored data. Node and pad
 * coordinates are world-space metres.
 * @throws RangeError for gas giants or invalid chunk coordinates.
 */
export function generateSurfaceChunk(
  seed: string,
  planet: Planet,
  chunkX: number,
  chunkZ: number,
): SurfaceChunk {
  checkChunkCoord('chunkX', chunkX);
  checkChunkCoord('chunkZ', chunkZ);
  const field = createSurfaceField(seed, planet);

  const heightmap: number[] = new Array<number>(CHUNK_SAMPLES * CHUNK_SAMPLES);
  for (let j = 0; j < CHUNK_SAMPLES; j++) {
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      const { x, z } = samplePosition(chunkX, chunkZ, i, j);
      heightmap[j * CHUNK_SAMPLES + i] = field.heightUnitsAt(x, z);
    }
  }

  const origin = { x0: chunkX * CHUNK_SIZE_M, z0: chunkZ * CHUNK_SIZE_M };
  const planetSeed = hash2(seedFromString(seed), BigInt(`0x${planet.id}`));
  const chunkSeed = hash2(hash2(planetSeed, BigInt(chunkX)), BigInt(chunkZ));
  const rng = new Rng(chunkSeed);

  const landingPads = placePads(
    rng,
    chunkSeed,
    origin,
    field,
    planet,
    chunkX === 0 && chunkZ === 0,
  );
  const resourceNodes = placeNodes(rng, chunkSeed, origin, field, planet, landingPads);
  const biome = field.biomeAt(origin.x0 + CHUNK_SIZE_M / 2, origin.z0 + CHUNK_SIZE_M / 2);

  return { chunkX, chunkZ, heightmap, biome, resourceNodes, landingPads };
}
