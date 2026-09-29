import { CELL_SIZE_M, CHUNK_SIZE, generateSurfaceChunk } from '@shared/galaxy/surface';
import type { LandingPadRef } from '@shared/physics/flight';
import type { Planet } from '@shared/galaxy/types';

/**
 * Per-ship terrain context for the atmosphere regime (TASK-13).
 *
 * Caches the 3x3 surface-chunk neighborhood around the ship (each chunk is
 * 64 cells x 5 m = 320 m, so 3x3 covers ~1 km — well inside the 512 m lookup
 * radius the spec allows) and answers heightAt(x, z) with a bilinear sample
 * over that cache: O(1) steady state, one generateSurfaceChunk call per chunk
 * crossed. Pads come from the same cached neighborhood.
 */
export class TerrainContext {
  private readonly seed: string;
  private readonly planet: Planet;
  private readonly chunks = new Map<string, ReturnType<typeof generateSurfaceChunk>>();
  private curX = 0;
  private curZ = 0;
  private primed = false;
  private padsCache: LandingPadRef[] = [];
  private padsDirty = true;

  constructor(seed: string, planet: Planet) {
    this.seed = seed;
    this.planet = planet;
  }

  /** World cell (5 m grid) → containing chunk coordinate (64 cells/chunk). */
  static chunkOfCoord(coord: number): number {
    return Math.floor(coord / CHUNK_SIZE);
  }

  /** World metres → world cell on the 5 m grid (floor, negative-safe). */
  static cellOfMetres(m: number): number {
    return Math.floor(m / CELL_SIZE_M);
  }

  /**
   * Refresh the cached neighborhood to the chunk containing (x, z) metres.
   * Cheap when the ship stays in the current chunk (the common case).
   */
  update(x: number, z: number): void {
    const cx = TerrainContext.chunkOfCoord(TerrainContext.cellOfMetres(x));
    const cz = TerrainContext.chunkOfCoord(TerrainContext.cellOfMetres(z));
    if (this.primed && cx === this.curX && cz === this.curZ) return;
    this.primed = true;
    this.curX = cx;
    this.curZ = cz;
    const wanted = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = `${cx + dx},${cz + dz}`;
        wanted.add(key);
        if (!this.chunks.has(key)) {
          this.chunks.set(key, generateSurfaceChunk(this.seed, this.planet, cx + dx, cz + dz));
        }
      }
    }
    for (const key of this.chunks.keys()) {
      if (!wanted.has(key)) this.chunks.delete(key);
    }
    this.padsDirty = true;
  }

  /** Bilinear terrain height (m) at world metres (x, z). */
  heightAt(x: number, z: number): number {
    const fx = x / CELL_SIZE_M;
    const fz = z / CELL_SIZE_M;
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    const tx = fx - cx;
    const tz = fz - cz;
    const h00 = this.cellHeight(cx, cz);
    const h10 = this.cellHeight(cx + 1, cz);
    const h01 = this.cellHeight(cx, cz + 1);
    const h11 = this.cellHeight(cx + 1, cz + 1);
    const top = h00 + (h10 - h00) * tx;
    const bottom = h01 + (h11 - h01) * tx;
    return top + (bottom - top) * tz;
  }

  private cellHeight(cellX: number, cellZ: number): number {
    const chunkX = TerrainContext.chunkOfCoord(cellX);
    const chunkZ = TerrainContext.chunkOfCoord(cellZ);
    const key = `${chunkX},${chunkZ}`;
    let chunk = this.chunks.get(key);
    if (!chunk) {
      // Only reachable if update() has not covered this neighborhood yet
      // (first tick); generate on demand so heightAt never misses.
      chunk = generateSurfaceChunk(this.seed, this.planet, chunkX, chunkZ);
      this.chunks.set(key, chunk);
    }
    const localX = cellX - chunkX * CHUNK_SIZE;
    const localZ = cellZ - chunkZ * CHUNK_SIZE;
    return chunk.heightmap[localZ * CHUNK_SIZE + localX];
  }

  /**
   * Landing pads in the cached neighborhood, in WORLD metres (the stored
   * pad coords are chunk-origin-relative: world = chunk * 320 m + local).
   * Recomputed per chunk change; heightAt uses the same world frame, so
   * findPad's radius test compares like with like.
   */
  pads(): LandingPadRef[] {
    if (!this.padsDirty) return this.padsCache;
    const out: LandingPadRef[] = [];
    const chunkMeters = CHUNK_SIZE * CELL_SIZE_M;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const chunkX = this.curX + dx;
        const chunkZ = this.curZ + dz;
        const chunk = this.chunks.get(`${chunkX},${chunkZ}`);
        if (!chunk) continue;
        for (const pad of chunk.landingPads) {
          out.push({
            id: pad.id,
            x: chunkX * chunkMeters + pad.x,
            z: chunkZ * chunkMeters + pad.z,
          });
        }
      }
    }
    this.padsCache = out;
    this.padsDirty = false;
    return out;
  }
}
