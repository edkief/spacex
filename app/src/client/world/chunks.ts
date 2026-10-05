/**
 * TASK-26: the surface streaming pipeline — chunk grid, LOD rings, active
 * set, frame-sliced generation scheduler, and the 400-chunk LRU cache.
 *
 * Everything is derived from (GALAXY_SEED, planet, chunk key): no network,
 * no server. The CONTRACT with the render loop: `update()` processes at most
 * `budgetMs` (default 4 ms) of generation per call, nearest-first, so
 * streaming never stalls a frame. When the queue runs deep the far-ring
 * impostor tier is dropped first (and logged) — near LOD is always built
 * before the player can reach the chunk edge (verified in the scripted
 * flight benchmark, streaming-benchmark.test.ts).
 *
 * Grid: TASK-5 terrain chunks (64 cells x 5 m = 320 m). The spec's "512 m
 * cell" describes the same near ring at the chunk level: the 3x3 near block
 * spans 960 m and its far corners sit at ~452 m — inside the 512 m near
 * distance. Active set: at rest the 3x3 block plus the four cardinal chunks
 * two away (13 chunks in a 5x5 span); at/above FAST_TRAVEL_SPEED the full
 * 7x7 (49) so fast flight never outruns generation.
 */

import {
  CHUNK_METERS,
  ChunkBuild,
  ImpostorBuild,
  RING_TRIANGLES,
  type BuiltChunk,
} from './chunk-geometry';
import { perfWarn } from '@client/perf/logger';
import type { Planet } from '@shared/galaxy/types';

/** LOD ring boundaries (meters, player to chunk CENTER) — the HIGH preset. */
export const LOD_NEAR_MAX_M = 512;
export const LOD_MID_MAX_M = 2_048;
export const LOD_FAR_MAX_M = 8_000;

/**
 * TASK-55: the LIVE LOD radii (the SettingsBridge). The module constants
 * above are the high-preset DEFAULTS; `setLodRadii` re-points the ring
 * classifier at the active quality preset's radii (lodRadiiFor, TASK-55).
 * The streamer reads these on EVERY generation, so a preset change
 * re-tunes the pipeline with no re-init: NEW chunks (and impostor→full
 * upgrades) use the new radii, and existing chunks keep their built LOD
 * until regenerated (mountable() never downgrades a full build to the
 * impostor quad — no pop).
 */
const liveLod: { nearMaxM: number; midMaxM: number; farMaxM: number } = {
  nearMaxM: LOD_NEAR_MAX_M,
  midMaxM: LOD_MID_MAX_M,
  farMaxM: LOD_FAR_MAX_M,
};

/** Re-point the ring classifier (TASK-55 preset change — live, no re-init). */
export function setLodRadii(r: { nearMaxM: number; midMaxM: number; farMaxM: number }): void {
  liveLod.nearMaxM = r.nearMaxM;
  liveLod.midMaxM = r.midMaxM;
  liveLod.farMaxM = r.farMaxM;
}

/** The live radii (a copy — the e2e dev hook reads this). */
export function lodRadii(): { nearMaxM: number; midMaxM: number; farMaxM: number } {
  return { ...liveLod };
}

/** LRU cap: 400 chunks stays under 100 MB of geometry (see RING_BYTES). */
export const DEFAULT_LRU_CAP = 400;
/** The render-loop contract: at most this much generation work per frame. */
export const DEFAULT_FRAME_BUDGET_MS = 4;
/** At/above this speed the active set expands to 7x7 (pop-in headroom). */
export const FAST_TRAVEL_SPEED = 100;
/** Surface-triangle draw budget for the default quality preset. */
export const SURFACE_TRIANGLE_BUDGET = 400_000;
/** Backlog depth at which the far impostor tier stops scheduling. */
const FAR_DROP_BACKLOG = 8;
/** Far impostor window: Chebyshev radius around the player chunk. */
const FAR_WINDOW_CHEBYSHEV = 6;

export type RingWithNone = 'near' | 'mid' | 'far' | 'none';

/** "chunkX,chunkZ" — the chunk key everything is cached by. */
export function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

/** Inverse of chunkKey (throws on a malformed key). */
export function parseChunkKey(key: string): { chunkX: number; chunkZ: number } {
  const m = /^(-?\d+),(-?\d+)$/.exec(key);
  const chunkX = m ? Number(m[1]) : NaN;
  const chunkZ = m ? Number(m[2]) : NaN;
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw new Error(`invalid chunk key: ${key}`);
  }
  return { chunkX, chunkZ };
}

/** World meters → chunk coordinate on the 320 m grid (negative-safe). */
export function chunkOfMeters(m: number): number {
  return Math.floor(m / CHUNK_METERS);
}

/** Player→chunk-center offset (m) — the LOD ring is picked on this distance. */
export function chunkCenterOffset(
  chunkX: number,
  chunkZ: number,
  playerX: number,
  playerZ: number,
): { dx: number; dz: number } {
  return {
    dx: chunkX * CHUNK_METERS + CHUNK_METERS / 2 - playerX,
    dz: chunkZ * CHUNK_METERS + CHUNK_METERS / 2 - playerZ,
  };
}

/** LOD ring for a player→chunk-center distance (m; the LIVE radii). */
export function lodRingForDistance(d: number): RingWithNone {
  if (d <= liveLod.nearMaxM) return 'near';
  if (d <= liveLod.midMaxM) return 'mid';
  if (d <= liveLod.farMaxM) return 'far';
  return 'none';
}

/** LOD ring for one chunk relative to the player position (m). */
export function lodRingForChunk(
  chunkX: number,
  chunkZ: number,
  playerX: number,
  playerZ: number,
): RingWithNone {
  const { dx, dz } = chunkCenterOffset(chunkX, chunkZ, playerX, playerZ);
  return lodRingForDistance(Math.hypot(dx, dz));
}

export interface ActiveChunk {
  chunkX: number;
  chunkZ: number;
  ring: RingWithNone;
  /** Player→chunk-center distance (m). */
  distance: number;
}

/**
 * The active (mounted) set around the player: at rest the 3x3 near block +
 * the four cardinal chunks two away (13); at/above FAST_TRAVEL_SPEED the
 * full 7x7 (49). Sorted nearest-first by center distance.
 */
export function activeSet(playerX: number, playerZ: number, speed: number): ActiveChunk[] {
  const pcx = chunkOfMeters(playerX);
  const pcz = chunkOfMeters(playerZ);
  const fast = speed >= FAST_TRAVEL_SPEED;
  // At rest the span is 5x5 but only the 3x3 block + the four c===2
  // cardinals are kept (the filter below) — 13 chunks.
  const radius = fast ? 3 : 2;
  const out: ActiveChunk[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (!fast) {
        const c = Math.max(Math.abs(dx), Math.abs(dz));
        if (c > 1 && !(c === 2 && (dx === 0 || dz === 0))) continue;
      }
      const { dx: ox, dz: oz } = chunkCenterOffset(pcx + dx, pcz + dz, playerX, playerZ);
      const distance = Math.hypot(ox, oz);
      out.push({
        chunkX: pcx + dx,
        chunkZ: pcz + dz,
        ring: lodRingForDistance(distance),
        distance,
      });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/**
 * TASK-55: keep an existing chunk's built LOD when a preset change
 * re-classifies it into the far ring (the no-pop rule). A full build
 * (mid geometry present) keeps at least 'mid'; impostor-only entries are
 * unaffected. Exported for the unit tests.
 */
export function keepBuiltLod(
  built: { geometries: { mid: unknown; far: unknown } },
  ring: 'near' | 'mid' | 'far',
): 'near' | 'mid' | 'far' {
  return ring === 'far' && built.geometries.mid !== null ? 'mid' : ring;
}

/** One cached (ready) chunk entry of the LRU. */
export interface CachedChunk {
  key: string;
  chunkX: number;
  chunkZ: number;
  built: BuiltChunk;
  /** LRU stamp: last frame the chunk was mounted/active. */
  lastAccessFrame: number;
}

export interface StreamUpdateStats {
  /** Wall ms the generation phase of this update spent. */
  processedMs: number;
  /** Chunks newly scheduled this frame. */
  scheduled: number;
  /** Chunks that finished this frame. */
  completed: number;
  /** Chunks evicted by the LRU this frame. */
  evicted: number;
  /** Far-ring impostors NOT scheduled this frame (backlog pressure). */
  farDropped: number;
  /** In-flight builds. */
  pending: number;
  /** Ready chunks in the LRU. */
  ready: number;
  /** Total generation work ms of the slowest chunk finished so far. */
  maxChunkWorkMs: number;
  /** Ready chunks in their current LOD ring (triangles, all mounted set). */
  triangles: { near: number; mid: number; far: number };
}

export interface StreamerOptions {
  /** Per-frame generation budget (ms). Default 4 (render-loop contract). */
  budgetMs?: number;
  /** LRU capacity in chunks. Default 400. */
  lruCap?: number;
  /** Injectable clock (tests). Default performance.now. */
  clock?: () => number;
  onChunkReady?: (key: string) => void;
  onChunkEvict?: (key: string) => void;
}

type Build = ChunkBuild | ImpostorBuild;

/**
 * Owns generation + the LRU for one planet's surface. `update()` is called
 * once per frame with the player position + speed; it re-derives the active
 * set, schedules missing chunks (active full builds first, then the far
 * impostor window), processes the nearest-first queue within the frame
 * budget, and evicts beyond the LRU cap (never an active chunk).
 */
export class ChunkStreamer {
  private readonly seed: string;
  private readonly planet: Planet;
  private readonly budgetMs: number;
  private readonly lruCap: number;
  private readonly clock: () => number;
  private readonly onChunkReady?: (key: string) => void;
  private readonly onChunkEvict?: (key: string) => void;

  private readonly builds = new Map<string, { build: Build; workMs: number; isFar: boolean }>();
  private readonly cached = new Map<string, CachedChunk>();
  private frame = 0;
  private maxChunkWorkMs = 0;
  private lastFarDropLog = -Infinity;
  /** Previous player position — derives the heading for priority (null until the 2nd update). */
  private lastPx: number | null = null;
  private lastPz: number | null = null;

  constructor(seed: string, planet: Planet, options: StreamerOptions = {}) {
    this.seed = seed;
    this.planet = planet;
    this.budgetMs = options.budgetMs ?? DEFAULT_FRAME_BUDGET_MS;
    this.lruCap = options.lruCap ?? DEFAULT_LRU_CAP;
    this.clock = options.clock ?? (() => performance.now());
    this.onChunkReady = options.onChunkReady;
    this.onChunkEvict = options.onChunkEvict;
  }

  /** Ready (fully generated) chunks, including impostor-only entries. */
  get readyCount(): number {
    return this.cached.size;
  }

  /** In-flight chunk builds. */
  get pendingCount(): number {
    return this.builds.size;
  }

  isReady(key: string): boolean {
    return this.cached.has(key);
  }

  getCached(key: string): CachedChunk | undefined {
    return this.cached.get(key);
  }

  /** All cached entries (LRU eviction tests, memory estimates). */
  entries(): IterableIterator<CachedChunk> {
    return this.cached.values();
  }

  /**
   * The mountable set for the scene: active chunks in their current LOD ring
   * plus ready far-ring impostors outside the active window (the horizon).
   * Side effect: stamps `lastAccessFrame` on everything mountable, so the
   * LRU never evicts a mounted chunk out from under the scene.
   */
  mountable(
    playerX: number,
    playerZ: number,
    speed: number,
  ): Array<{ entry: CachedChunk; ring: 'near' | 'mid' | 'far' }> {
    const out: Array<{ entry: CachedChunk; ring: 'near' | 'mid' | 'far' }> = [];
    const seen = new Set<string>();
    for (const a of activeSet(playerX, playerZ, speed)) {
      const entry = this.cached.get(chunkKey(a.chunkX, a.chunkZ));
      if (!entry) continue;
      let ring = lodRingForChunk(a.chunkX, a.chunkZ, playerX, playerZ);
      // TASK-55: a preset change re-classifies distances live — a chunk
      // BUILT as full terrain keeps its LOD until regenerated (never
      // downgraded to the impostor quad; no pop).
      if (ring === 'far') ring = keepBuiltLod(entry.built, ring);
      if (ring === 'near' || ring === 'mid' || ring === 'far') {
        entry.lastAccessFrame = this.frame;
        out.push({ entry, ring });
        seen.add(entry.key);
      }
    }
    for (const entry of this.cached.values()) {
      if (seen.has(entry.key)) continue;
      if (lodRingForChunk(entry.chunkX, entry.chunkZ, playerX, playerZ) !== 'far') continue;
      entry.lastAccessFrame = this.frame;
      // Horizon: the impostor quad by design (a full build OUTSIDE the
      // active window still mounts as the cheap far quad — the no-pop rule
      // above applies to the active set only; mounting full terrain at
      // 8 km breaks the triangle budget).
      out.push({ entry, ring: 'far' });
      seen.add(entry.key);
    }
    return out;
  }

  /** One frame of streaming (see class doc). */
  update(playerX: number, playerZ: number, speed: number): StreamUpdateStats {
    this.frame += 1;
    let scheduled = 0;
    let completed = 0;
    let farDropped = 0;

    const active = activeSet(playerX, playerZ, speed);
    const activeKeys = new Set(active.map((a) => chunkKey(a.chunkX, a.chunkZ)));

    // Schedule: active full builds first (nearest-first), then the far
    // impostor window — dropped (and logged, rate-limited) under backlog.
    // An impostor-cached chunk that enters the active set gets a FULL build
    // scheduled alongside its cache entry (the horizon quad was cached while
    // far; the player is approaching and the quad must upgrade to terrain
    // long before the chunk edge — the scene keeps the quad mounted until
    // the replacement entry lands, so there is no blank frame).
    for (const a of active) {
      const key = chunkKey(a.chunkX, a.chunkZ);
      if (this.builds.has(key)) continue;
      const existing = this.cached.get(key);
      if (existing && existing.built.chunk !== null) continue; // full: done
      this.builds.set(key, {
        build: new ChunkBuild(this.seed, this.planet, a.chunkX, a.chunkZ),
        workMs: 0,
        isFar: false,
      });
      scheduled += 1;
    }
    if (this.builds.size < FAR_DROP_BACKLOG) {
      const pcx = chunkOfMeters(playerX);
      const pcz = chunkOfMeters(playerZ);
      const far: Array<{ key: string; cx: number; cz: number; d: number }> = [];
      for (let dx = -FAR_WINDOW_CHEBYSHEV; dx <= FAR_WINDOW_CHEBYSHEV; dx++) {
        for (let dz = -FAR_WINDOW_CHEBYSHEV; dz <= FAR_WINDOW_CHEBYSHEV; dz++) {
          const cx = pcx + dx;
          const cz = pcz + dz;
          const key = chunkKey(cx, cz);
          if (activeKeys.has(key) || this.cached.has(key) || this.builds.has(key)) continue;
          if (lodRingForChunk(cx, cz, playerX, playerZ) !== 'far') continue;
          const { dx: ox, dz: oz } = chunkCenterOffset(cx, cz, playerX, playerZ);
          far.push({ key, cx, cz, d: Math.hypot(ox, oz) });
        }
      }
      far.sort((a, b) => a.d - b.d);
      for (const f of far) {
        this.builds.set(f.key, {
          build: new ImpostorBuild(this.seed, this.planet, f.cx, f.cz),
          workMs: 0,
          isFar: true,
        });
        scheduled += 1;
      }
    } else {
      farDropped = this.countFarInWindow(playerX, playerZ, activeKeys);
      const now = this.clock();
      if (now - this.lastFarDropLog >= 1_000) {
        this.lastFarDropLog = now;
        perfWarn(
          `streaming backlog ${this.builds.size}: dropping far-ring generation first (near LOD unaffected)`,
          { backlog: this.builds.size, farDropped },
        );
      }
    }

    // Process the priority queue within the frame budget. Priority is
    // nearest-first CORRECTED FOR HEADING: progress made toward a chunk
    // while it waits is subtracted from its distance, so at max flight
    // speed the forward column is built before the player reaches its
    // edge (acceptance: no pop-in within 100 m of a chunk edge), while
    // radial chunks behind are deferred. At rest (no heading) this is
    // exactly nearest-first. The player does not move inside update(),
    // so the order is stable — sort once.
    let dir: { dx: number; dz: number } | null = null;
    if (this.lastPx !== null && this.lastPz !== null) {
      const mx = playerX - this.lastPx;
      const mz = playerZ - this.lastPz;
      const len = Math.hypot(mx, mz);
      if (len > 0) dir = { dx: mx / len, dz: mz / len };
    }
    const queue = [...this.builds.entries()].sort((a, b) => {
      const [ea, da] = this.buildPriority(a, playerX, playerZ, dir);
      const [eb, db] = this.buildPriority(b, playerX, playerZ, dir);
      return ea - eb || da - db; // effective distance, ties by raw distance
    });
    const t0 = this.clock();
    let i = 0;
    while (i < queue.length) {
      const [key, pending] = queue[i];
      pending.workMs += pending.build.advanceUnit(this.clock);
      if (pending.build.done) {
        const built = pending.build.built;
        const { chunkX, chunkZ } = parseChunkKey(key);
        // Impostor→full upgrade: replace the cached quad and free its
        // geometry (the scene swaps its mesh pointer on the next sync).
        const replaced = this.cached.get(key);
        if (replaced) {
          replaced.built.geometries.near?.dispose();
          replaced.built.geometries.mid?.dispose();
          replaced.built.geometries.far.dispose();
        }
        this.cached.set(key, { key, chunkX, chunkZ, built, lastAccessFrame: this.frame });
        this.builds.delete(key);
        this.maxChunkWorkMs = Math.max(this.maxChunkWorkMs, pending.workMs);
        completed += 1;
        this.onChunkReady?.(key);
        i += 1; // next build
      }
      // A not-done build just needs another unit — keep working on it until
      // the budget is actually spent (one unit per frame would starve the
      // queue: a 15-unit chunk would take 15 frames instead of ~4).
      if (this.clock() - t0 >= this.budgetMs) break;
    }

    // LRU: evict the least-recently-accessed chunk beyond the cap — never
    // an active chunk (its next frame would re-request it).
    let evicted = 0;
    while (this.cached.size > this.lruCap) {
      let victim: CachedChunk | null = null;
      for (const entry of this.cached.values()) {
        if (activeKeys.has(entry.key)) continue;
        if (!victim || entry.lastAccessFrame < victim.lastAccessFrame) victim = entry;
      }
      if (!victim) break; // everything is active — nothing safe to evict
      this.cached.delete(victim.key);
      this.onChunkEvict?.(victim.key);
      evicted += 1;
    }

    // Triangle tally over the mountable set, by the LOD ring in use
    // (mountable() also stamps the LRU for everything the scene will draw).
    const triangles = { near: 0, mid: 0, far: 0 };
    for (const m of this.mountable(playerX, playerZ, speed)) {
      const g = m.entry.built.geometries;
      if (m.ring === 'near' && g.near) triangles.near += RING_TRIANGLES.near;
      else if (m.ring === 'mid' && g.mid) triangles.mid += RING_TRIANGLES.mid;
      else if (m.ring === 'far' && g.far) triangles.far += RING_TRIANGLES.far;
    }

    this.lastPx = playerX;
    this.lastPz = playerZ;
    return {
      processedMs: this.clock() - t0,
      scheduled,
      completed,
      evicted,
      farDropped,
      pending: this.builds.size,
      ready: this.cached.size,
      maxChunkWorkMs: this.maxChunkWorkMs,
      triangles,
    };
  }

  /**
   * Drop all state and dispose geometries (new system / warp / teardown).
   * The scene must unmount before calling (it keys its meshes by chunk key).
   */
  reset(): void {
    this.builds.clear();
    for (const entry of this.cached.values()) {
      entry.built.geometries.near?.dispose();
      entry.built.geometries.mid?.dispose();
      entry.built.geometries.far.dispose();
    }
    this.cached.clear();
    this.frame = 0;
    this.maxChunkWorkMs = 0;
    this.lastPx = null;
    this.lastPz = null;
  }

  private countFarInWindow(playerX: number, playerZ: number, activeKeys: Set<string>): number {
    const pcx = chunkOfMeters(playerX);
    const pcz = chunkOfMeters(playerZ);
    let n = 0;
    for (let dx = -FAR_WINDOW_CHEBYSHEV; dx <= FAR_WINDOW_CHEBYSHEV; dx++) {
      for (let dz = -FAR_WINDOW_CHEBYSHEV; dz <= FAR_WINDOW_CHEBYSHEV; dz++) {
        const key = chunkKey(pcx + dx, pcz + dz);
        if (activeKeys.has(key) || this.cached.has(key) || this.builds.has(key)) continue;
        if (lodRingForChunk(pcx + dx, pcz + dz, playerX, playerZ) === 'far') n += 1;
      }
    }
    return n;
  }

  /**
   * [effective distance, raw distance] of one pending build. The effective
   * distance subtracts the progress the player's heading makes toward the
   * chunk center (a chunk straight ahead sorts at ~0, a chunk behind at
   * 2x its distance); see the update() comment for why.
   */
  private buildPriority(
    entry: [string, { build: Build; workMs: number; isFar: boolean }],
    px: number,
    pz: number,
    dir: { dx: number; dz: number } | null,
  ): [number, number] {
    const { chunkX, chunkZ } = parseChunkKey(entry[0]);
    const { dx, dz } = chunkCenterOffset(chunkX, chunkZ, px, pz);
    const dist = Math.hypot(dx, dz);
    const eff = dir ? dist - (dx * dir.dx + dz * dir.dz) : dist;
    return [eff, dist];
  }
}
