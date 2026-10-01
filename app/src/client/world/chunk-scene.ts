/**
 * TASK-26: the three.js scene layer over the streaming pipeline.
 *
 * ChunkScene owns a THREE.Group of one mesh per mounted chunk (world
 * position = chunk origin; geometry is chunk-local). `sync()` is called once
 * per frame with the player position + speed: it mounts newly-ready chunks,
 * swaps a mesh's geometry when its LOD ring changes (the mip chain was
 * pre-built at generation, so the swap is a pointer change — no pop, no
 * rebuild), and unmounts chunks that left the mountable set. Materials are
 * shared per biome (TASK-5 biome palette); impostor entries use the flat
 * horizon color. LRU evictions arrive via `handleEvict()` — geometry is
 * disposed by the streamer, the scene just drops its mesh reference.
 *
 * Per frame the scene also reports its triangle tally by LOD ring to the
 * frame monitor (per-category counters, TASK-57 extension) and checks the
 * 400k surface-triangle gauge — the draw-distance budget of the default
 * quality preset.
 */

import * as THREE from 'three';
import { frameMonitor, type FrameMonitor } from '@client/perf/frameMonitor';
import { SURFACE_TRIANGLE_BUDGET, type CachedChunk, type ChunkStreamer } from './chunks';
import type { Biome } from '@shared/galaxy/types';

/** Biome palette for terrain materials (deterministic, shared per biome). */
export const BIOME_COLORS: Record<Biome, string> = {
  plains: '#5f8f4a',
  rock: '#8a8a91',
  canyon: '#b0623c',
  frozen: '#dfe9ef',
  wetland: '#4e7c59',
};
/** Far-ring impostor (flat horizon) color — a muted blend of the palette. */
export const FAR_IMPOSTOR_COLOR = '#6b7280';

/** Triangles mounted this frame, by the LOD ring in use. */
export interface SceneTriangleStats {
  near: number;
  mid: number;
  far: number;
  mounted: number;
}

export interface ChunkSceneOptions {
  /** Frame monitor to report to. Default: the app-wide singleton. */
  monitor?: FrameMonitor;
  /** Register the surface-tris gauge + report each frame. Default true. */
  reportBudget?: boolean;
}

export class ChunkScene {
  readonly group = new THREE.Group();
  private readonly streamer: ChunkStreamer;
  private readonly monitor: FrameMonitor;
  private readonly reportBudget: boolean;
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly biomeMaterials = new Map<Biome, THREE.Material>();
  private readonly farMaterial: THREE.Material;

  constructor(streamer: ChunkStreamer, options: ChunkSceneOptions = {}) {
    this.streamer = streamer;
    this.monitor = options.monitor ?? frameMonitor;
    this.reportBudget = options.reportBudget ?? true;
    this.farMaterial = new THREE.MeshBasicMaterial({ color: FAR_IMPOSTOR_COLOR });
    if (this.reportBudget) this.monitor.registerGauge('surface-tris', SURFACE_TRIANGLE_BUDGET);
  }

  materialFor(biome: Biome | null): THREE.Material {
    if (biome === null) return this.farMaterial;
    let m = this.biomeMaterials.get(biome);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: BIOME_COLORS[biome] });
      this.biomeMaterials.set(biome, m);
    }
    return m;
  }

  /**
   * One frame of scene management (see class doc). Returns the per-ring
   * triangle tally of what is now mounted.
   */
  sync(playerX: number, playerZ: number, speed: number): SceneTriangleStats {
    const wanted = this.streamer.mountable(playerX, playerZ, speed);
    const wantKeys = new Set(wanted.map((w) => w.entry.key));

    // Unmount chunks that left the mountable set (geometry survives in the
    // LRU until evicted — a return trip re-mounts without rebuilding).
    for (const [key, mesh] of this.meshes) {
      if (!wantKeys.has(key)) {
        this.group.remove(mesh);
        this.meshes.delete(key);
      }
    }

    const stats: SceneTriangleStats = { near: 0, mid: 0, far: 0, mounted: 0 };
    for (const { entry, ring } of wanted) {
      const geometry = ringGeometry(entry, ring);
      if (!geometry) continue;
      let mesh = this.meshes.get(entry.key);
      if (!mesh) {
        mesh = new THREE.Mesh(geometry, this.materialFor(entry.built.chunk?.biome ?? null));
        mesh.position.set(entry.chunkX * 320, 0, entry.chunkZ * 320);
        mesh.frustumCulled = true;
        this.group.add(mesh);
        this.meshes.set(entry.key, mesh);
      } else if (mesh.geometry !== geometry) {
        // LOD ring changed: swap the pre-built mip (no pop-in).
        mesh.geometry = geometry;
      }
      stats[ring] += triCount(geometry);
      stats.mounted += 1;
    }

    if (this.reportBudget) {
      this.monitor.reportCategories({
        'surface-near': stats.near,
        'surface-mid': stats.mid,
        'surface-far': stats.far,
      });
      this.monitor.gaugeCheck('surface-tris', stats.near + stats.mid + stats.far);
    }
    return stats;
  }

  /** LRU eviction: the streamer disposed the geometry; drop the mesh. */
  handleEvict(key: string): void {
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    this.group.remove(mesh);
    this.meshes.delete(key);
  }

  /** Number of meshes currently in the group (tests, stats). */
  get mountedCount(): number {
    return this.meshes.size;
  }

  /** Dispose materials (geometries belong to the streamer). */
  dispose(): void {
    for (const m of this.biomeMaterials.values()) m.dispose();
    this.farMaterial.dispose();
    this.biomeMaterials.clear();
    this.meshes.clear();
  }
}

function ringGeometry(
  entry: CachedChunk,
  ring: 'near' | 'mid' | 'far',
): THREE.BufferGeometry | null {
  const g = entry.built.geometries;
  if (ring === 'near') return g.near;
  if (ring === 'mid') return g.mid;
  return g.far;
}

function triCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return index ? index.count / 3 : (geometry.getAttribute('position')?.count ?? 0) / 3;
}
