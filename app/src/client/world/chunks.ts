import * as THREE from 'three';
import { Planet, Biome } from '../../shared/galaxy/types';
import { generateSurfaceChunk, SurfaceChunk } from '../../shared/galaxy/surface';
import { frameMonitor } from '../perf/frameMonitor';

export type ChunkKey = string;

export function getChunkKey(x: number, z: number): ChunkKey {
  return `${x},${z}`;
}

export interface ChunkGeometries {
  near: THREE.BufferGeometry;
  mid: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  biome: Biome;
}

/**
 * Generates THREE.js geometries for a surface chunk at different LOD levels.
 */
export function generateChunkGeometries(seed: string, planet: Planet, cx: number, cz: number): ChunkGeometries {
  const chunkData = generateSurfaceChunk(seed, planet, cx, cz);
  const heightmap = chunkData.heightmap;
  const chunkSize = 512;
  const res = 64;
  const spacing = chunkSize / res;

  const createGeometry = (stride: number) => {
    const vertices: number[] = [];
    const indices: number[] = [];
    const actualRes = res / stride;

    for (let z = 0; z < actualRes; z++) {
      for (let x = 0; x < actualRes; x++) {
        const ox = x * stride;
        const oz = z * stride;
        // Sample heightmap (clamp to 63 since heightmap is 64x64)
        const h = heightmap[Math.min(oz, 63) * res + Math.min(ox, 63)];
        vertices.push(ox * spacing, h, oz * spacing);
      }
    }

    for (let z = 0; z < actualRes - 1; z++) {
      for (let x = 0; x < actualRes - 1; x++) {
        const i = z * actualRes + x;
        indices.push(i, i + 1, i + actualRes);
        indices.push(i + 1, i + actualRes + 1, i + actualRes);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  };

  return {
    near: createGeometry(1),
    mid: createGeometry(2),
    far: createGeometry(8),
    biome: chunkData.biome,
  };
}

/**
 * Manages the asynchronous generation of chunks to avoid frame drops.
 */
export class FrameScheduler {
  private queue: { key: ChunkKey; priority: number; resolve: (geo: ChunkGeometries) => void }[] = [];
  private isProcessing = false;

  public schedule(key: ChunkKey, priority: number, resolve: (geo: ChunkGeometries) => void) {
    this.queue.push({ key, priority, resolve });
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  public update(seed: string, planet: Planet) {
    if (this.queue.length === 0) return;

    const startTime = performance.now();
    const budget = 4; // 4ms limit per frame

    while (this.queue.length > 0 && performance.now() - startTime < budget) {
      const task = this.queue.shift();
      if (task) {
        const [cx, cz] = task.key.split(',').map(Number);
        const geo = generateChunkGeometries(seed, planet, cx, cz);
        task.resolve(geo);
      }
    }

    frameMonitor.budgetCheck('chunk-generation', performance.now() - startTime, budget);
  }
}

/**
 * Manages the active set of chunks and their LRU cache.
 */
export class ChunkManager {
  private cache = new Map<ChunkKey, { geo: ChunkGeometries; lastUsed: number }>();
  private activeKeys = new Set<ChunkKey>();
  private scheduler = new FrameScheduler();
  private maxCacheSize = 400;

  constructor(private seed: string, private planet: Planet) {}

  public update(playerPos: THREE.Vector3, velocity: THREE.Vector3): Set<ChunkKey> {
    const chunkSize = 512;
    const cx = Math.floor(playerPos.x / chunkSize);
    const cz = Math.floor(playerPos.z / chunkSize);

    // Expand active set based on velocity
    const speed = velocity.length();
    const ringSize = speed > 100 ? 3 : 2; // 7x7 for fast, 5x5 for slow
    
    const newActiveKeys = new Set<ChunkKey>();
    for (let x = cx - ringSize; x <= cx + ringSize; x++) {
      for (let z = cz - ringSize; z <= cz + ringSize; z++) {
        if (Math.abs(x - cx) + Math.abs(z - cz) > ringSize) continue;
        const key = getChunkKey(x, z);
        newActiveKeys.add(key);
        
        if (!this.cache.has(key)) {
          const priority = 1 / (Math.abs(x - cx) + Math.abs(z - cz) + 1);
          this.scheduler.schedule(key, priority, (geo) => {
            this.cache.set(key, { geo, lastUsed: Date.now() });
          });
        } else {
          this.cache.get(key)!.lastUsed = Date.now();
        }
      }
    }

    this.activeKeys = newActiveKeys;
    this.evictOldChunks();
    
    return this.activeKeys;
  }

  private evictOldChunks() {
    if (this.cache.size <= this.maxCacheSize) return;

    const sorted = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    while (this.cache.size > this.maxCacheSize) {
      const [key, value] = sorted.shift()!;
      // Dispose geometries
      value.geo.near.dispose();
      value.geo.mid.dispose();
      value.geo.far.dispose();
      this.cache.delete(key);
    }
  }

  public getGeometry(key: ChunkKey): ChunkGeometries | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.geo;
    }
    return undefined;
  }

  public updateScheduler() {
    this.scheduler.update(this.seed, this.planet);
  }
}
