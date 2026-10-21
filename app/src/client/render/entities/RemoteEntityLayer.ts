/**
 * Remote entity layer — TASK-75.
 *
 * Turns the 10 Hz snapshot buffers the WS client already keeps
 * (`DriftClient.remoteEntityBuffers`) into pooled three.js meshes.
 * Every frame the owning render loop calls
 * `sync(buffers, nowMs)`; the layer samples each buffer at
 * `nowMs` (which interpolates at `INTERP_DELAY_MS` behind the
 * render clock — see `RemoteEntityBuffer.sample`) and writes the
 * resulting pose onto a pooled object.
 *
 * Policy:
 *   - The own entity is never rendered (the own ship mesh owns it).
 *   - A stale sample (`REMOTE_STALE_MS`, 1000 ms without a fresh
 *     snapshot) HIDES the mesh. Freezing silently would let a
 *     despawned ship hang in space forever; after
 *     `REMOTE_RELEASE_STALE_MS` the mesh goes back to the pool.
 *     Static props (`STATIC_REMOTE_KINDS`) are exempt — the shard
 *     only re-publishes them on change.
 *   - An id that disappears from the buffer map releases its mesh
 *     immediately (the shard dropped the entity).
 *
 * The layer owns no React state and never touches the network, so
 * a unit test drives it with a plain `Map` of fake buffers.
 */
import { Group, type Object3D, Quaternion, Vector3 } from "three";

import { REMOTE_STALE_MS } from "@client/net/prediction.js";
import { SPIN_RATE_KEY } from "./entityMeshFactory.js";
import { EntityMeshPool } from "./entityPool.js";

import type { EntityMeshContext } from "./entityMeshFactory.js";
import type { RemoteEntityBuffer } from "@client/net/prediction.js";
import type { ProtocolEntityKind } from "@shared/protocol/index.js";

/**
 * A stale remote is hidden for a grace period, then released back
 * to the pool. Three stale windows is long enough to ride out a
 * GC pause or a backgrounded tab without leaking a mesh per player.
 */
export const REMOTE_RELEASE_STALE_MS = REMOTE_STALE_MS * 3;

/** Kind assumed when a snapshot carries no wire `kind` (older
 *  server or a hand-built buffer). Ships are the common case. */
export const DEFAULT_REMOTE_KIND: ProtocolEntityKind = "ship";

/**
 * Kinds the shard deliberately omits from the 10 Hz broadcast and
 * pushes only when they change (see `STATIC_ENTITY_KINDS` in
 * `@server/shard/index.ts`). Their buffers go stale by design, so
 * the stale-hide rule does not apply — a deposit that nobody mined
 * for a minute must not blink out of the world.
 */
export const STATIC_REMOTE_KINDS: ReadonlySet<ProtocolEntityKind> = new Set<ProtocolEntityKind>([
  "deposit",
  "terminal",
]);

export interface RemoteEntityLayerOptions {
  /** Mesh-building dependencies (paint registry). */
  readonly context: EntityMeshContext;
  /** Ids never rendered — normally the own `entity:<shipId>`. */
  readonly ownEntityIds?: readonly string[];
  /** Per-kind pool cap. Default 24. */
  readonly maxPerKind?: number;
}

/** One live remote: its pooled object plus the kind it was built
 *  for (a kind can change mid-flight: ship → character on land). */
interface RemoteEntry {
  readonly object: Object3D;
  kind: ProtocolEntityKind;
  /** Render-clock ms of the last frame the sample was fresh. */
  lastFreshMs: number;
}

// Scratch objects — `sync` runs at frame rate, so it allocates
// nothing per frame.
const scratchQuat = new Quaternion();
const spinAxis = new Vector3(0, 0, 1);

/** Copy a protocol pose onto a three.js object. */
function writePose(
  object: Object3D,
  pos: { x: number; y: number; z: number },
  q: {
    x: number;
    y: number;
    z: number;
    w: number;
  },
): void {
  object.position.set(pos.x, pos.y, pos.z);
  object.quaternion.set(q.x, q.y, q.z, q.w);
}

/**
 * Pooled remote-entity meshes for one render host.
 */
export class RemoteEntityLayer {
  /** Scene container. Parents every live remote mesh. */
  readonly root: Group;
  readonly #pool: EntityMeshPool;
  readonly #entries = new Map<string, RemoteEntry>();
  readonly #own = new Set<string>();
  /** Frames where a buffer threw. Surfaced for the e2e/debug HUD. */
  errorCount = 0;

  constructor(options: RemoteEntityLayerOptions) {
    this.#pool = new EntityMeshPool(options.context, { maxPerKind: options.maxPerKind });
    this.root = new Group();
    this.root.userData["remoteEntityLayer"] = true;
    for (const id of options.ownEntityIds ?? []) this.#own.add(id);
  }

  /** Visible remote meshes. This is the number the e2e pins. */
  get remoteMeshCount(): number {
    let n = 0;
    for (const entry of this.#entries.values()) if (entry.object.visible) n += 1;
    return n;
  }

  /** Meshes attached to the scene, visible or hidden. */
  get attachedCount(): number {
    return this.#entries.size;
  }

  /** Meshes currently checked out of the pool. */
  get poolLiveCount(): number {
    return this.#pool.liveCount;
  }

  /** Idle meshes retained per kind / in total (reuse assertion). */
  pooledCount(kind?: ProtocolEntityKind): number {
    return this.#pool.pooledCount(kind);
  }

  /** Kind a given entity id's mesh was built for (test seam). */
  kindOf(entityId: string): ProtocolEntityKind | null {
    return this.#entries.get(entityId)?.kind ?? null;
  }

  /** The pooled object for an id (test seam — do not mutate). */
  objectOf(entityId: string): Object3D | null {
    return this.#entries.get(entityId)?.object ?? null;
  }

  /**
   * Replace the never-rendered id set. The WS client owns the
   * own entity id, so GameCanvas re-pushes it when a live client
   * lands and clears it on teardown.
   */
  setOwnEntityIds(ids: readonly string[]): void {
    this.#own.clear();
    for (const id of ids) this.#own.add(id);
  }

  /**
   * Per-frame sync. `buffers` is the client's
   * `remoteEntityBuffers` map; `nowMs` is the render clock
   * (`Date.now()` in production, a counter in tests).
   */
  sync(buffers: ReadonlyMap<string, RemoteEntityBuffer>, nowMs: number): void {
    const seen = new Set<string>();
    for (const [id, buf] of buffers) {
      if (this.#own.has(id)) continue;
      seen.add(id);
      try {
        this.#syncOne(id, buf, nowMs);
      } catch {
        // A malformed snapshot must never take down the frame
        // loop — drop the entity and carry on.
        this.errorCount += 1;
        this.#releaseEntry(id);
      }
    }
    // Ids that vanished from the map release their mesh at once.
    for (const id of [...this.#entries.keys()]) {
      if (!seen.has(id)) this.#releaseEntry(id);
    }
  }

  /**
   * Sample one remote and write its pose. Splits out of `sync` so
   * the per-frame loop stays readable and unit-testable.
   */
  #syncOne(id: string, buf: RemoteEntityBuffer, nowMs: number): void {
    const { state, stale } = buf.sample(nowMs);
    let entry = this.#entries.get(id);
    const sampledKind = state?.kind;
    if (entry !== undefined && sampledKind !== undefined && sampledKind !== entry.kind) {
      // The entity changed kind (landing on a pad swaps a ship for
      // a character). Swap the pooled mesh for the matching one.
      this.#releaseEntry(id);
      entry = undefined;
    }
    if (entry === undefined) {
      const kind = sampledKind ?? DEFAULT_REMOTE_KIND;
      entry = { object: this.#pool.acquire(kind), kind, lastFreshMs: nowMs };
      this.#entries.set(id, entry);
      this.root.add(entry.object);
    }
    const live = entry;
    if (state === null || (stale && !STATIC_REMOTE_KINDS.has(live.kind))) {
      live.object.visible = false;
      if (nowMs - live.lastFreshMs >= REMOTE_RELEASE_STALE_MS) this.#releaseEntry(id);
      return;
    }
    live.lastFreshMs = nowMs;
    live.object.visible = true;
    writePose(live.object, state.pos, state.quat);
    const rate = live.object.userData[SPIN_RATE_KEY];
    if (typeof rate === "number" && Number.isFinite(rate)) {
      // Spinning meshes keep their interpolated orientation and
      // then rotate about their own axis — mutating `.rotation`
      // would clobber the quaternion we just wrote.
      scratchQuat.setFromAxisAngle(spinAxis, (nowMs / 1000) * rate);
      live.object.quaternion.multiply(scratchQuat);
    }
  }

  /** Detach an entity's mesh and hand it back to the pool. */
  #releaseEntry(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.#entries.delete(id);
    this.#pool.release(entry.kind, entry.object);
  }

  /**
   * Tear the layer down: release every live mesh (which returns it
   * to the pool) and dispose the pooled geometries. Idempotent.
   */
  dispose(): void {
    for (const id of [...this.#entries.keys()]) this.#releaseEntry(id);
    this.root.removeFromParent();
    this.root.clear();
    this.#pool.clear();
  }
}
