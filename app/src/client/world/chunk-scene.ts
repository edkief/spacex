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
 * Streaming deferral (TASK-30.1): while the player is MOVING and the
 * streamer is draining a chunk burst (it scheduled work recently), a
 * freshly-mountable near/mid chunk is merged into the FAR group — one
 * impostor quad — instead of its full ring group. A ring-group re-merge
 * copies the WHOLE group's geometry, and during descent/ascent the mid
 * ring's membership changes every burst frame, so those re-merges were
 * the dominant transition-hitch cost. The quad is exactly what the chunk
 * showed before its full build finished (the impostor→full upgrade is the
 * pipeline's normal direction, so there is no pop). Once the streamer has
 * scheduled nothing for `UPGRADE_QUIET_SYNC` consecutive syncs — beyond
 * the 24-frame burst-drain window of the transition harness — the
 * deferred chunks re-merge into their real rings, ONE (ring, biome) group
 * per sync so every re-merge stays bounded even on a frame the harness
 * tags (first mesh of a group = `material-swap`). At rest (speed 0) the
 * same one-group-per-sync promotion converges within a handful of frames,
 * and a scene that never deferred converges in a single sync.
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

/**
 * Consecutive quiet syncs (streamer scheduled no new work) before a
 * deferred chunk re-merges into its real ring. One past the 24-frame
 * burst-drain tagging window of the transition harness, so the re-merge
 * lands on an untagged frame.
 */
const UPGRADE_QUIET_SYNC = 25;

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
  /**
   * Merged mode, streaming deferral: chunk key → its REAL (ring, biome)
   * while it is mounted as a far-ring quad (see module doc).
   */
  private readonly deferred = new Map<string, { ring: LodRing; biome: Biome | null }>();
  /** Merged mode: consecutive syncs where the streamer scheduled no work. */
  private quietSyncs = 0;
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
   * state (the AC-1 at-rest window) is a plain membership walk. While the
   * player moves through a streaming burst, fresh near/mid chunks mount as
   * far quads and re-merge into their real rings one group per sync once
   * the burst drains (streaming deferral, see module doc).
   */
  private syncMerged(playerX: number, playerZ: number, speed: number): SceneTriangleStats {
    const wanted = this.streamer.mountable(playerX, playerZ, speed);
    this.quietSyncs = this.streamer.lastScheduled > 0 ? 0 : this.quietSyncs + 1;
    // Deferring = moving + burst window still hot: fresh near/mid chunks
    // mount as far quads so the heavy ring re-merges wait for quiet.
    const deferring = speed > 0 && this.quietSyncs < UPGRADE_QUIET_SYNC;
    const next = new Map<string, { ring: LodRing; biome: Biome | null }>();
    const stats: SceneTriangleStats = { near: 0, mid: 0, far: 0, mounted: 0 };

    for (const { entry, ring } of wanted) {
      const geometry = ringGeometry(entry, ring);
      if (!geometry) continue; // nothing built for this ring yet — skip
      const biome = entry.built.chunk?.biome ?? null;
      stats[ring] += triCount(geometry); // tally follows the streamer's ring
      stats.mounted += 1;
      if (deferring && ring !== 'far') {
        this.deferred.set(entry.key, { ring, biome });
        next.set(entry.key, { ring: 'far', biome }); // quad until the burst drains
      } else {
        this.deferred.delete(entry.key); // at its real ring (or far): not deferred
        next.set(entry.key, { ring, biome });
      }
    }
    // A deferred chunk that left the mountable set is no longer deferred.
    for (const key of [...this.deferred.keys()]) {
      if (!next.has(key)) this.deferred.delete(key);
    }

    // Burst drained (or at rest): re-merge ONE deferred group this sync so
    // each re-merge stays bounded (see module doc).
    if (!deferring && this.deferred.size > 0) this.promoteOneGroup(next);

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
   * Re-merge the first deferred (ring, biome) group into its real ring
   * (all of its chunks in one re-merge — one group's geometry copy is the
   * bounded unit of work).
   */
  private promoteOneGroup(next: Map<string, { ring: LodRing; biome: Biome | null }>): void {
    const first = this.deferred.values().next().value;
    if (!first) return;
    const groupKey = `${first.ring}:${first.biome ?? 'far'}`;
    for (const [key, real] of [...this.deferred]) {
      if (`${real.ring}:${real.biome ?? 'far'}` !== groupKey) continue;
      next.set(key, { ring: real.ring, biome: real.biome });
      this.deferred.delete(key);
    }
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
      const geometry = this.buildMergedGeometry(
        members.map(({ entry, ring }) => this.translatedFor(entry, ring)),
      );
      const mesh = new THREE.Mesh(geometry, this.materialFor(biome));
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.meshes.set(gk, mesh);
      this.builtGroupSigs.set(gk, sig);
    }
  }

  /**
   * Merge a group's world-translated mip copies into one BufferGeometry.
   * Every member of a (ring, biome) group carries the SAME mip grid
   * (position + Uint16 index, identical counts), so the common case is a
   * raw typed-array concat — a native `set()` per member's positions plus
   * one vertex-offset add over the (small) index array. That replaces
   * three's `mergeGeometries`, whose per-vertex JS loops measured
   * 3.7-8.7 ms for a 20-member mid group where the concat is < 0.5 ms.
   * Falls back to `mergeGeometries` when the attribute sets ever diverge
   * (mixed counts / index types / no index) or the group would exceed the
   * Uint16 vertex range.
   */
  private buildMergedGeometry(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const first = geos[0];
    const firstIdx = first.getIndex();
    const firstPos = first.getAttribute('position');
    if (
      firstIdx &&
      firstIdx.array instanceof Uint16Array &&
      firstPos.array instanceof Float32Array
    ) {
      const verts = firstPos.count;
      const idxCount = firstIdx.count;
      let uniform = verts * geos.length <= 0xffff;
      for (let i = 1; uniform && i < geos.length; i++) {
        const idx = geos[i].getIndex();
        uniform =
          geos[i].getAttribute('position').count === verts &&
          idx !== null &&
          idx.count === idxCount &&
          idx.array instanceof Uint16Array &&
          geos[i].getAttribute('position').array instanceof Float32Array;
      }
      if (uniform) {
        const posOut = new Float32Array(verts * 3 * geos.length);
        const idxOut = new Uint16Array(idxCount * geos.length);
        let posOff = 0;
        let idxOff = 0;
        let vertOff = 0;
        for (const g of geos) {
          posOut.set(g.getAttribute('position').array as Float32Array, posOff);
          const srcIdx = g.getIndex()!.array as Uint16Array;
          for (let k = 0; k < idxCount; k++) idxOut[idxOff + k] = srcIdx[k] + vertOff;
          posOff += verts * 3;
          idxOff += idxCount;
          vertOff += verts;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(posOut, 3));
        geo.setIndex(new THREE.BufferAttribute(idxOut, 1));
        geo.computeBoundingSphere(); // frustumCulled meshes need bounds to draw
        return geo;
      }
    }
    return mergeGeometries(geos, false)!;
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
    // Typed-array copy + in-place x/z offset (a per-vertex getX/getY/getZ
    // loop here was the dominant cost of a ring-group re-merge).
    const pos = src.getAttribute('position');
    const srcArr = pos.array as Float32Array;
    const packed = new Float32Array(srcArr);
    for (let v = 0; v < srcArr.length; v += 3) {
      packed[v] += offset;
      packed[v + 2] += offsetZ;
    }
    copy.setAttribute('position', new THREE.BufferAttribute(packed, 3));
    const index = src.getIndex();
    if (index) copy.setIndex(index.clone());
    // No boundingSphere: the copy is never drawn — only its attribute
    // arrays are merged into a ring-group geometry (which computes bounds
    // at build time).
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
      this.deferred.delete(key);
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
    this.deferred.clear();
    this.quietSyncs = 0;
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
