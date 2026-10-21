/**
 * Per-kind mesh pool — TASK-75.
 *
 * A 16-player system plus AI ships, wrecks, drones and missiles
 * churns entity ids every second. Allocating a `THREE.Group` per
 * remote every frame is how the renderer ends up with a GC saw
 * tooth, so every mesh the layer acquires is borrowed from here and
 * returned when the id leaves the snapshot.
 *
 * The pool is bounded per kind (`maxPerKind`, default 24): once
 * the free list is exhausted, `acquire` builds a fresh mesh —
 * correctness never depends on the bound, only the frame budget
 * does.
 *
 * Pure three.js + the factory; no React, no network, no clock.
 */
import type { Object3D } from "three";

import { buildEntityMesh, disposeEntityMesh, type EntityMeshContext } from "./entityMeshFactory.js";

import type { ProtocolEntityKind } from "@shared/protocol/index.js";

/** Default free-list length per kind. */
export const DEFAULT_POOL_MAX_PER_KIND = 24;

export interface EntityMeshPoolOptions {
  /** Max idle meshes retained per kind. Default 24. */
  maxPerKind?: number;
}

/**
 * Free-list of meshes keyed by kind. `acquire` / `release` are
 * symmetric; `release` of an unknown object is ignored so a
 * double-release cannot corrupt the free list.
 */
export class EntityMeshPool {
  readonly #free = new Map<ProtocolEntityKind, Object3D[]>();
  readonly #maxPerKind: number;
  #live = 0;
  #peak = 0;

  constructor(
    private readonly ctx: EntityMeshContext,
    options: EntityMeshPoolOptions = {},
  ) {
    this.#maxPerKind = options.maxPerKind ?? DEFAULT_POOL_MAX_PER_KIND;
  }

  /** Number of meshes currently handed out (`acquired`). */
  get liveCount(): number {
    return this.#live;
  }

  /** High-water mark of `liveCount` — unit-test seam for reuse. */
  get peakCount(): number {
    return this.#peak;
  }

  /** Idle meshes retained across all kinds. */
  pooledCount(kind?: ProtocolEntityKind): number {
    if (kind !== undefined) return this.#free.get(kind)?.length ?? 0;
    let total = 0;
    for (const list of this.#free.values()) total += list.length;
    return total;
  }

  /** Borrow a mesh for the kind, reusing an idle one when the
   *  free list has room. The returned object is `visible = true`
   *  and detached from any parent. */
  acquire(kind: ProtocolEntityKind): Object3D {
    const list = this.#free.get(kind);
    const reused = list !== undefined && list.length > 0 ? list.pop() : undefined;
    const object = reused ?? buildEntityMesh(kind, this.ctx);
    object.visible = true;
    this.#live += 1;
    if (this.#live > this.#peak) this.#peak = this.#live;
    return object;
  }

  /**
   * Return a mesh. Objects over the per-kind cap are disposed
   * instead of retained; releasing a mesh the pool never handed
   * out is a no-op (the caller may double-release during a React
   * StrictMode teardown race).
   */
  release(kind: ProtocolEntityKind, object: Object3D): void {
    object.visible = false;
    object.removeFromParent();
    const list = this.#free.get(kind) ?? [];
    if (list.length < this.#maxPerKind) {
      list.push(object);
      this.#free.set(kind, list);
    } else {
      disposeEntityMesh(object);
    }
    if (this.#live > 0) this.#live -= 1;
  }

  /**
   * Dispose every idle mesh and forget the free lists. Meshes
   * still checked out are detached by their owner (the layer's
   * `dispose`) before this runs.
   */
  clear(): void {
    for (const list of this.#free.values()) {
      for (const object of list) disposeEntityMesh(object);
    }
    this.#free.clear();
    this.#live = 0;
  }
}
