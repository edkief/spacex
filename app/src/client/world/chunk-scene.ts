/**
 * TASK-26: the three.js scene layer over the streaming pipeline.
 *
 * Legacy path (`merged: false` — the benchmark's pre-tuning baseline, the
 * same flag pattern as `merged: false` in remote-ships.ts): one mesh per
 * mounted chunk (world position = chunk origin; geometry is chunk-local).
 * `sync()` is called once per frame with the player position + speed: it
 * mounts newly-ready chunks, swaps a mesh's geometry when its LOD ring
 * changes (the mip chain was pre-built at generation, so the swap is a
 * pointer change — no pop, no rebuild), and unmounts chunks that left the
 * mountable set. Materials are shared per biome (TASK-5 biome palette);
 * impostor entries use the flat horizon color.
 *
 * Tuned path (default since TASK-58.2): ONE merged mesh per (LOD ring,
 * shared biome material) — a ring per planet is a handful of draw calls
 * instead of up to 13. A ring's chunk geometries are merged into a single
 * BufferGeometry the first time the mounted (key → ring, material) set
 * CHANGES — and only the (ring, material) groups whose membership changed
 * are rebuilt (per-group signatures), never all of them at once. Steady
 * state (the AC-1 at-rest window) never rebuilds — the per-frame cost is
 * the same membership walk as the legacy path. Any mount / unmount / LOD
 * swap / eviction marks the scene dirty; changed groups are rebuilt from
 * the pre-built mips (chunk geometries stay owned by the streamer — the
 * merge copies their attribute data).
 *
 * Per frame the scene also reports its triangle tally by LOD ring to the
 * frame monitor (per-category counters, TASK-57 extension) and checks the
 * 400k surface-triangle gauge — the draw-distance budget of the default
 * quality preset. LRU evictions arrive via `handleEvict()` — geometry is
 * disposed by the streamer, the scene just drops the chunk (and rebuilds
 * the merged ring in the tuned path).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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

/** The LOD rings (chunks.ts's 'near' | 'mid' | 'far'), spelled out for the merge key. */
type LodRing = 'near' | 'mid' | 'far';

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
  /**
   * Tuned mode (default, TASK-58.2): one merged mesh per (LOD ring, shared
   * biome material) instead of one per chunk. `merged: false` keeps the
   * legacy per-chunk meshes — the benchmark's pre-tuning baseline (the same
   * flag pattern as `merged: false` in remote-ships.ts /
   * `instanced: false` in ore-rocks.ts).
   */
  merged?: boolean;
}

export class ChunkScene {
  readonly group = new THREE.Group();
  private readonly streamer: ChunkStreamer;
  private readonly monitor: FrameMonitor;
  private readonly reportBudget: boolean;
  private readonly merged: boolean;
  /** Legacy mode: chunk key → its mesh. Merged mode: ring key → merged mesh. */
  private readonly meshes = new Map<string, THREE.Mesh>();
  /** Merged mode: chunk key → what it is mounted with (membership + dirty source). */
  private mounted = new Map<string, { ring: LodRing; biome: Biome | null }>();
  /** Merged mode: last synced membership (for the per-frame structural diff). */
  private prevMounted: Map<string, { ring: LodRing; biome: Biome | null }> | null = null;
  /** Merged mode: group key → built member signature (per-group dirty check). */
  private readonly builtGroupSigs = new Map<string, string>();
  /**
   * Merged mode: `chunkKey:ring` → world-translated position+index copy of
   * that mip, plus the source geometry it was packed from (an impostor→full
   * upgrade replaces the entry's geometry under the same key — a stale copy
   * is rebuilt when the source identity changes). Built once per (chunk,
   * ring) and reused by every merged rebuild — the per-rebuild cost is the
   * merge copy, not a fresh clone of each member. The `normal` attribute
   * is dropped: the scene's materials are unlit (MeshBasicMaterial) and
   * never read it, so the merged buffer carries only what the draw uses.
   */
  private readonly translatedCache = new Map<
    string,
    { geo: THREE.BufferGeometry; src: THREE.BufferGeometry }
  >();
  private readonly biomeMaterials = new Map<Biome, THREE.Material>();
  private readonly farMaterial: THREE.Material;

  constructor(streamer: ChunkStreamer, options: ChunkSceneOptions = {}) {
    this.streamer = streamer;
    this.monitor = options.monitor ?? frameMonitor;
    this.reportBudget = options.reportBudget ?? true;
    this.merged = options.merged ?? true;
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
    const stats = this.merged
      ? this.syncMerged(playerX, playerZ, speed)
      : this.syncLegacy(playerX, playerZ, speed);

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

  /**
   * Legacy path: one mesh per mounted chunk; an LOD ring change is a
   * geometry pointer swap on the same mesh (no pop-in, no rebuild).
   */
  private syncLegacy(playerX: number, playerZ: number, speed: number): SceneTriangleStats {
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
    return stats;
  }

  /**
   * Tuned path: one merged mesh per (LOD ring, shared biome material).
   * Walks the mountable set, diffs the membership against the last build,
   * and rebuilds the merged ring geometries ONLY when it changed — steady
   * state (the AC-1 at-rest window) is a plain membership walk.
   */
  private syncMerged(playerX: number, playerZ: number, speed: number): SceneTriangleStats {
    const wanted = this.streamer.mountable(playerX, playerZ, speed);
    const next = new Map<string, { ring: LodRing; biome: Biome | null }>();
    const stats: SceneTriangleStats = { near: 0, mid: 0, far: 0, mounted: 0 };

    for (const { entry, ring } of wanted) {
      const geometry = ringGeometry(entry, ring);
      if (!geometry) continue; // nothing built for this ring yet — skip
      const biome = entry.built.chunk?.biome ?? null;
      next.set(entry.key, { ring, biome });
      stats[ring] += triCount(geometry);
      stats.mounted += 1;
    }

    // Membership changed? (mount, unmount, LOD swap, or biome change) — a
    // plain structural diff: no per-frame string building or sorting.
    if (membershipChanged(this.prevMounted, next)) {
      this.prevMounted = next;
      this.mounted = next;
      this.rebuildRingMeshes();
    }
    return stats;
  }

  /**
   * Rebuild the (ring, material) groups whose membership CHANGED since the
   * last build: one merged BufferGeometry per rebuilt group, chunk
   * geometries translated to world position and copied (the streamer keeps
   * owning the originals). Unchanged groups keep their merged mesh — during
   * streaming a frame typically touches one or two rings, so a full
   * all-groups rebuild (the previous behaviour) wasted most of its clone +
   * merge work on groups whose membership was identical. Vanished groups
   * (their membership emptied) have the merged geometry disposed.
   */
  private rebuildRingMeshes(): void {
    const groups = new Map<
      string,
      Array<{ entry: CachedChunk; ring: LodRing; biome: Biome | null }>
    >();
    for (const [key, info] of this.mounted) {
      const entry = this.streamer.getCached(key);
      if (!entry) continue;
      const gk = `${info.ring}:${info.biome ?? 'far'}`;
      const list = groups.get(gk);
      if (list) list.push({ entry, ...info });
      else groups.set(gk, [{ entry, ...info }]);
    }

    // Drop vanished groups — the merged geometry is ours to free.
    for (const gk of [...this.builtGroupSigs.keys()]) {
      if (groups.has(gk)) continue;
      const mesh = this.meshes.get(gk);
      if (mesh) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(gk);
      }
      this.builtGroupSigs.delete(gk);
    }

    for (const [gk, members] of groups) {
      const sig = members
        .map((m) => m.entry.key)
        .sort()
        .join(',');
      if (this.builtGroupSigs.get(gk) === sig) continue; // membership unchanged
      const prev = this.meshes.get(gk);
      if (prev) {
        this.group.remove(prev);
        prev.geometry.dispose();
        this.meshes.delete(gk);
      }
      const [, biomeKey] = gk.split(':') as [string, string];
      const biome = biomeKey === 'far' ? null : (biomeKey as Biome);
      const geometry = mergeGeometries(
        members.map(({ entry, ring }) => this.translatedFor(entry, ring)),
        false,
      )!;
      const mesh = new THREE.Mesh(geometry, this.materialFor(biome));
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.meshes.set(gk, mesh);
      this.builtGroupSigs.set(gk, sig);
    }
  }

  /**
   * World-translated position+index copy of a chunk mip, cached per
   * (chunk, ring). The streamer keeps owning the original; this copy is
   * the scene's and survives across merged rebuilds.
   */
  private translatedFor(entry: CachedChunk, ring: LodRing): THREE.BufferGeometry {
    const cacheKey = `${entry.key}:${ring}`;
    const src = ringGeometry(entry, ring)!;
    const hit = this.translatedCache.get(cacheKey);
    if (hit && hit.src === src) return hit.geo;
    if (hit) hit.geo.dispose(); // source replaced (impostor→full upgrade)
    const copy = new THREE.BufferGeometry();
    const offset = entry.chunkX * 320;
    const offsetZ = entry.chunkZ * 320;
    // Re-pack positions with the chunk offset baked in (the original is
    // chunk-local); normals are dropped — unlit materials never read them.
    const pos = src.getAttribute('position');
    const packed = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) {
      packed[v * 3] = pos.getX(v) + offset;
      packed[v * 3 + 1] = pos.getY(v);
      packed[v * 3 + 2] = pos.getZ(v) + offsetZ;
    }
    copy.setAttribute('position', new THREE.BufferAttribute(packed, 3));
    const index = src.getIndex();
    if (index) copy.setIndex(index.clone());
    copy.computeBoundingSphere();
    this.translatedCache.set(cacheKey, { geo: copy, src });
    return copy;
  }

  /** Drop the translated copies of an evicted chunk (the scene frees them). */
  private releaseTranslated(key: string): void {
    for (const ring of ['near', 'mid', 'far'] as const) {
      const cacheKey = `${key}:${ring}`;
      const hit = this.translatedCache.get(cacheKey);
      if (hit) {
        hit.geo.dispose();
        this.translatedCache.delete(cacheKey);
      }
    }
  }

  /** LRU eviction: the streamer disposed the geometry; drop the chunk. */
  handleEvict(key: string): void {
    if (this.merged) {
      this.releaseTranslated(key);
      if (this.mounted.delete(key)) this.prevMounted = null; // diff next sync
      return;
    }
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    this.group.remove(mesh);
    this.meshes.delete(key);
  }

  /** Number of CHUNKS currently mounted (tests, stats) — both paths. */
  get mountedCount(): number {
    return this.merged ? this.mounted.size : this.meshes.size;
  }

  /** Number of meshes in the group (tuned: per (ring, material) group). */
  get meshCount(): number {
    return this.meshes.size;
  }

  /**
   * Dispose scene-owned resources. The merged ring geometries are the
   * scene's to free (the merge copied the chunk geometry data); the legacy
   * per-chunk geometries belong to the streamer and are never touched.
   */
  dispose(): void {
    for (const m of this.biomeMaterials.values()) m.dispose();
    this.farMaterial.dispose();
    this.biomeMaterials.clear();
    if (this.merged) {
      for (const mesh of this.meshes.values()) mesh.geometry.dispose();
      for (const { geo } of this.translatedCache.values()) geo.dispose();
    }
    this.meshes.clear();
    this.mounted.clear();
    this.builtGroupSigs.clear();
    this.translatedCache.clear();
    this.prevMounted = null;
  }
}

/**
 * Structural membership diff (no string building / sorting — this runs
 * every frame). null prev = first sync (treat as changed).
 */
function membershipChanged(
  prev: Map<string, { ring: LodRing; biome: Biome | null }> | null,
  next: Map<string, { ring: LodRing; biome: Biome | null }>,
): boolean {
  if (prev === null || prev.size !== next.size) return true;
  for (const [key, info] of next) {
    const p = prev.get(key);
    if (!p || p.ring !== info.ring || p.biome !== info.biome) return true;
  }
  return false;
}

function ringGeometry(entry: CachedChunk, ring: LodRing): THREE.BufferGeometry | null {
  const g = entry.built.geometries;
  if (ring === 'near') return g.near;
  if (ring === 'mid') return g.mid;
  return g.far;
}

function triCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return index ? index.count / 3 : (geometry.getAttribute('position')?.count ?? 0) / 3;
}
