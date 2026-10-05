import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BIOME_COLORS, ChunkScene } from './chunk-scene';
import { chunkKey, ChunkStreamer, SURFACE_TRIANGLE_BUDGET } from './chunks';
import { RING_TRIANGLES } from './chunk-geometry';
import { FrameMonitor } from '@client/perf/frameMonitor';
import { setPerfLogSink } from '@client/perf/logger';
import { generateSystem } from '@shared/galaxy/system';
import type { Planet } from '@shared/galaxy/types';
import fixture from '@shared/galaxy/__fixtures__/surface-dev-seed-chunk00.json';

const SEED = fixture.seed;
const PLANET: Planet = generateSystem(SEED, fixture.starId).planets[fixture.planetIndex];

/** (160,160) is the exact center of chunk (0,0) — the player position here. */
const PX = 160;
const PZ = 160;

/** Frame cap for streamer wait loops: 4000 frames (~66 s of budget-sliced work) — a hang fails, not waits. */
const MAX_WAIT_FRAMES = 4000;

/** The scene's mount contract, re-derived independently: per-ring tris of everything mountable. */
function expectedTally(streamer: ChunkStreamer, px: number, pz: number) {
  const exp = { near: 0, mid: 0, far: 0, mounted: 0 };
  for (const w of streamer.mountable(px, pz, 0)) {
    exp[w.ring] += RING_TRIANGLES[w.ring];
    exp.mounted += 1;
  }
  return exp;
}

/** Find the mounted mesh for a chunk by its world position (x = cx*320, z = cz*320). */
function meshOf(scene: ChunkScene, cx: number, cz: number): THREE.Mesh {
  const mesh = scene.group.children.find(
    (c) => c instanceof THREE.Mesh && c.position.x === cx * 320 && c.position.z === cz * 320,
  );
  expect(mesh, `mesh for chunk (${cx},${cz})`).toBeInstanceOf(THREE.Mesh);
  return mesh as THREE.Mesh;
}

describe('ChunkScene legacy per-chunk path (TASK-26 step 2, merged: false)', () => {
  let monitor: FrameMonitor;
  let warned: string[];
  let streamer: ChunkStreamer;
  let scene: ChunkScene;

  beforeEach(() => {
    monitor = new FrameMonitor(); // fresh instance — never the app-wide singleton
    warned = [];
    setPerfLogSink((message) => warned.push(message));
    streamer = new ChunkStreamer(SEED, PLANET, {});
    scene = new ChunkScene(streamer, { monitor, merged: false });
  });

  afterEach(() => setPerfLogSink(null)); // restore the default console sink

  /** Frame-slice the streamer until the 3x3 near block is ready (~30 real frames). */
  function warmToNearBlock() {
    let stats = streamer.update(PX, PZ, 0);
    const block = [
      [-1, -1],
      [0, 0],
      [1, 1],
    ] as const;
    let frames = 0;
    while (!block.every(([cx, cz]) => streamer.isReady(chunkKey(cx, cz)))) {
      if (++frames > MAX_WAIT_FRAMES) {
        const missing = block
          .filter(([cx, cz]) => !streamer.isReady(chunkKey(cx, cz)))
          .map(([cx, cz]) => `(${cx},${cz})`)
          .join(' ');
        throw new Error(
          `warmToNearBlock stuck after ${MAX_WAIT_FRAMES} frames: ${missing} not ready (pending=${stats.pending})`,
        );
      }
      stats = streamer.update(PX, PZ, 0);
    }
    return stats;
  }

  it('registers the surface-tris gauge at 400k when reporting the budget', () => {
    expect(monitor.getGaugeStats('surface-tris').limit).toBe(SURFACE_TRIANGLE_BUDGET);
  });

  it('mounts exactly the mountable set and reports per-ring triangles to the monitor', () => {
    warmToNearBlock();
    const stats = scene.sync(PX, PZ, 0);

    // Everything the streamer says is mountable is mounted (and nothing else):
    // the 9 ready near chunks, plus ready cardinals/impostors if their builds
    // had already finished — re-derived independently, not hardcoded.
    const exp = expectedTally(streamer, PX, PZ);
    expect(exp.mounted).toBeGreaterThanOrEqual(9); // at least the 3x3 near block
    expect(scene.mountedCount).toBe(exp.mounted);
    expect(stats).toEqual(exp);

    // The monitor saw the per-category tally (TASK-57 category counters).
    expect(monitor.getFrameStats().categoryTriangles).toEqual({
      'surface-near': stats.near,
      'surface-mid': stats.mid,
      'surface-far': stats.far,
    });
    // Well under 400k → the gauge stayed silent.
    expect(monitor.getGaugeStats('surface-tris').warnings).toBe(0);

    // Materials: shared MeshBasicMaterial per biome (unlit — the scene has no lights).
    const mesh = meshOf(scene, 0, 0);
    expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const biome = streamer.getCached(chunkKey(0, 0))!.built.chunk!.biome;
    expect(`#${(mesh.material as THREE.MeshBasicMaterial).color.getHexString()}`).toBe(
      BIOME_COLORS[biome],
    );
    // The group is the scene's root (frustum culling is per-mesh via three.js).
    expect(mesh.parent).toBe(scene.group);
  });

  it('swaps a mesh geometry on an LOD ring change (pre-built mip — same mesh object)', () => {
    warmToNearBlock();
    scene.sync(PX, PZ, 0);
    const g00 = streamer.getCached(chunkKey(0, 0))!.built.geometries;
    expect(meshOf(scene, 0, 0).geometry).toBe(g00.near);

    // Let cardinal chunk (2,0) finish — at 640 m from the player it mounts as MID.
    let waitFrames = 0;
    while (!streamer.isReady(chunkKey(2, 0))) {
      if (++waitFrames > MAX_WAIT_FRAMES) {
        throw new Error(
          `LOD-swap wait stuck after ${MAX_WAIT_FRAMES} frames: chunk (2,0) not ready (pending=${streamer.pendingCount})`,
        );
      }
      streamer.update(PX, PZ, 0);
    }
    const t1 = scene.sync(PX, PZ, 0);
    expect(t1.mid).toBeGreaterThan(0);
    const mesh20 = meshOf(scene, 2, 0);
    expect(mesh20.geometry).toBe(streamer.getCached(chunkKey(2, 0))!.built.geometries.mid);

    // Move east to chunk (1,0)'s center: chunk (2,0) is now 320 m away → NEAR.
    // The same mesh object gets the pre-built near geometry — no remount, no pop.
    scene.sync(480, 160, 0);
    const mesh20b = meshOf(scene, 2, 0);
    expect(mesh20b).toBe(mesh20); // same object, re-mounted in place
    expect(mesh20b.geometry).toBe(streamer.getCached(chunkKey(2, 0))!.built.geometries.near);
    // The tally agrees with the (independently derived) mountable set.
    expect(expectedTally(streamer, 480, 160).mounted).toBeGreaterThan(0);
  });

  it('unmounts chunks that left the mountable set', () => {
    warmToNearBlock();
    scene.sync(PX, PZ, 0);
    const first = scene.mountedCount;
    expect(first).toBeGreaterThanOrEqual(9);

    // Fly > 8 km away: nothing in the (frozen) cache is within draw distance.
    // sync() does not schedule — only mountable() — so the ready set is stable.
    const t = scene.sync(12_000, 160, 0);
    expect(scene.mountedCount).toBe(0);
    expect(t.mounted).toBe(0);

    // Fly back: the cached chunks re-mount without any rebuild.
    const t2 = scene.sync(PX, PZ, 0);
    expect(scene.mountedCount).toBe(first);
    expect(t2.mounted).toBe(first);
  });

  it('handleEvict drops the mesh for an evicted chunk', () => {
    warmToNearBlock();
    scene.sync(PX, PZ, 0);
    const before = scene.mountedCount;
    scene.handleEvict(chunkKey(0, 0));
    expect(scene.mountedCount).toBe(before - 1);
    expect(() => meshOf(scene, 0, 0)).toThrow();
    // Unknown keys are a no-op (the streamer owns disposal).
    expect(() => scene.handleEvict('999,999')).not.toThrow();
  });

  it('warns (rate-limited) when the surface-tris gauge is exceeded', () => {
    warmToNearBlock();
    // Shrink the limit below the mounted tally → the per-frame check must fire.
    monitor.registerGauge('surface-tris', 1_000);
    const t = scene.sync(PX, PZ, 0);
    expect(t.near + t.mid + t.far).toBeGreaterThan(1_000);
    // (warmToNearBlock may also have logged the backlog drop warning —
    // target the gauge warning specifically.)
    const gaugeWarns = warned.filter((w) => w.includes('"surface-tris"'));
    expect(gaugeWarns).toHaveLength(1);
    expect(gaugeWarns[0]).toContain('perf gauge exceeded');
    // Cooldown: another frame at the same value does not re-warn.
    scene.sync(PX, PZ, 0);
    expect(warned.filter((w) => w.includes('"surface-tris"'))).toHaveLength(1);
    expect(monitor.getGaugeStats('surface-tris').maxValue).toBe(t.near + t.mid + t.far);
  });
});

describe('ChunkScene tuned merged path (TASK-58.2, merged: true)', () => {
  let monitor: FrameMonitor;
  let streamer: ChunkStreamer;
  let scene: ChunkScene;

  beforeEach(() => {
    monitor = new FrameMonitor(); // fresh instance — never the app-wide singleton
    setPerfLogSink(null);
    streamer = new ChunkStreamer(SEED, PLANET, {});
    scene = new ChunkScene(streamer, { monitor }); // merged is the default
    expect(scene).toBeInstanceOf(ChunkScene);
  });

  /** Frame-slice the streamer until the 3x3 near block is ready. */
  function warmToNearBlock() {
    let stats = streamer.update(PX, PZ, 0);
    const block = [
      [-1, -1],
      [0, 0],
      [1, 1],
    ] as const;
    let frames = 0;
    while (!block.every(([cx, cz]) => streamer.isReady(chunkKey(cx, cz)))) {
      if (++frames > MAX_WAIT_FRAMES) {
        const missing = block
          .filter(([cx, cz]) => !streamer.isReady(chunkKey(cx, cz)))
          .map(([cx, cz]) => `(${cx},${cz})`)
          .join(' ');
        throw new Error(
          `warmToNearBlock stuck after ${MAX_WAIT_FRAMES} frames: ${missing} not ready (pending=${stats.pending})`,
        );
      }
      stats = streamer.update(PX, PZ, 0);
    }
    return stats;
  }

  /**
   * Independently re-derive the merged contract: the per-ring tally and the
   * distinct (ring, biome) group keys — a chunk that is not built for its
   * ring (null geometry) is skipped, mirroring the scene.
   */
  function expectedMerged(px: number, pz: number) {
    const exp = { near: 0, mid: 0, far: 0, mounted: 0 };
    const groupKeys = new Set<string>();
    for (const w of streamer.mountable(px, pz, 0)) {
      const g =
        w.ring === 'near'
          ? w.entry.built.geometries.near
          : w.ring === 'mid'
            ? w.entry.built.geometries.mid
            : w.entry.built.geometries.far;
      if (!g) continue;
      exp[w.ring] += RING_TRIANGLES[w.ring];
      exp.mounted += 1;
      groupKeys.add(`${w.ring}:${w.entry.built.chunk?.biome ?? 'far'}`);
    }
    return { exp, groupKeys };
  }

  const meshes = (s: ChunkScene) =>
    s.group.children.filter((c) => c instanceof THREE.Mesh) as THREE.Mesh[];

  it('mounts every chunk as one merged mesh per (ring, biome) group', () => {
    warmToNearBlock();
    const stats = scene.sync(PX, PZ, 0);
    const { exp, groupKeys } = expectedMerged(PX, PZ);

    // One group per distinct (ring, biome) — strictly fewer meshes than
    // chunks whenever biomes repeat within a ring.
    expect(groupKeys.size).toBeLessThan(exp.mounted);
    expect(meshes(scene)).toHaveLength(groupKeys.size);
    // Every chunk is mounted (mountedCount counts CHUNKS, not meshes).
    expect(scene.mountedCount).toBe(exp.mounted);
    expect(scene.meshCount).toBe(groupKeys.size);
    // The per-ring triangle tally is unchanged by the merge.
    expect(stats).toEqual(exp);
    // Each merged mesh uses the shared biome/far material and carries the
    // whole group's triangles (its index counts the group's quads).
    for (const mesh of meshes(scene)) {
      expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
      const tri = mesh.geometry.getIndex()!.count / 3;
      expect(tri).toBeGreaterThan(0);
    }
    const total = meshes(scene).reduce((a, m) => a + m.geometry.getIndex()!.count / 3, 0);
    expect(total).toBe(exp.near + exp.mid + exp.far);
  });

  it('rebuilds nothing while the mounted (key → ring, material) set is stable', () => {
    warmToNearBlock();
    scene.sync(PX, PZ, 0);
    const first = meshes(scene).map((m) => ({ mesh: m, geometry: m.geometry }));
    expect(first.length).toBeGreaterThan(0);

    // Many steady-state frames: same mesh objects, same geometries, no
    // rebuild (the AC-1 at-rest window is a membership walk only).
    for (let i = 0; i < 20; i++) {
      const stats = scene.sync(PX, PZ, 0);
      expect(stats.mounted).toBe(scene.mountedCount);
    }
    const second = meshes(scene);
    expect(second).toHaveLength(first.length);
    for (const f of first) {
      const m = second.find((x) => x === f.mesh);
      expect(m, 'mesh object survives steady-state frames').toBeDefined();
      expect(m!.geometry).toBe(f.geometry);
    }
  });

  it('rebuilds the ring groups when a chunk changes LOD ring', () => {
    warmToNearBlock();
    scene.sync(PX, PZ, 0);
    let waitFrames = 0;
    while (!streamer.isReady(chunkKey(2, 0))) {
      if (++waitFrames > MAX_WAIT_FRAMES) {
        throw new Error(
          `LOD-swap wait stuck after ${MAX_WAIT_FRAMES} frames: chunk (2,0) not ready (pending=${streamer.pendingCount})`,
        );
      }
      streamer.update(PX, PZ, 0);
    }
    const t1 = scene.sync(PX, PZ, 0);
    const e1 = expectedMerged(PX, PZ);
    expect(t1).toEqual(e1.exp);
    expect(t1.mid).toBeGreaterThan(0);
    expect(meshes(scene)).toHaveLength(e1.groupKeys.size);

    // Move east to chunk (1,0)'s center: chunk (2,0) is now NEAR — the
    // near group's geometry must be rebuilt with (2,0)'s near mip inside.
    const nearBefore = meshes(scene).map((m) => m.geometry);
    scene.sync(480, 160, 0);
    const e2 = expectedMerged(480, 160);
    const t2 = scene.sync(480, 160, 0);
    expect(t2).toEqual(e2.exp);
    expect(meshes(scene)).toHaveLength(e2.groupKeys.size);
    // Some merged geometry changed (the near group absorbed chunk (2,0)).
    expect(meshes(scene).some((m) => !nearBefore.includes(m.geometry))).toBe(true);
    // The rebuilt groups still carry the full tally.
    const total = meshes(scene).reduce((a, m) => a + m.geometry.getIndex()!.count / 3, 0);
    expect(total).toBe(t2.near + t2.mid + t2.far);
  });

  it('unmounts when chunks leave the mountable set and re-mounts them back', () => {
    warmToNearBlock();
    scene.sync(PX, PZ, 0);
    const first = scene.mountedCount;
    expect(first).toBeGreaterThanOrEqual(9);

    // Fly > 8 km away: nothing in the (frozen) cache is within draw distance.
    const t = scene.sync(12_000, 160, 0);
    expect(scene.mountedCount).toBe(0);
    expect(t.mounted).toBe(0);
    expect(meshes(scene)).toHaveLength(0);

    // Fly back: the cached chunks re-mount (rebuild from the pre-built mips).
    const t2 = scene.sync(PX, PZ, 0);
    const exp = expectedMerged(PX, PZ);
    expect(scene.mountedCount).toBe(first);
    expect(t2).toEqual(exp.exp);
    expect(meshes(scene)).toHaveLength(exp.groupKeys.size);
  });

  it('LRU eviction rebuilds the ring groups without the evicted chunk', () => {
    // The live wiring: the streamer disposes an evicted chunk's geometry and
    // notifies the scene via onChunkEvict. A small LRU cap forces a REAL
    // eviction (the victim is always a non-active cached chunk — eviction
    // never touches the active set), so the chunk leaves the mountable set
    // and the merged groups rebuild from the pre-built mips without it.
    // (A direct handleEvict() on a still-mountable chunk is deliberately
    // undone by the next sync in the merged path: membership is
    // streamer-driven every frame — the streamer owns the lifecycle.)
    // The scene must exist before the streamer (its onChunkEvict callback
    // targets it) but the streamer must exist before the scene — a mutable
    // holder bridges the cycle (eviction only fires in update(), long
    // after both are wired).
    const evictSceneRef: { current: ChunkScene | null } = { current: null };
    const evictedKeys: string[] = [];
    const evictStreamer = new ChunkStreamer(SEED, PLANET, {
      lruCap: 16,
      onChunkEvict: (key) => {
        evictedKeys.push(key);
        evictSceneRef.current?.handleEvict(key);
      },
    });
    const evictScene = new ChunkScene(evictStreamer, {
      monitor: new FrameMonitor(),
      reportBudget: false,
    });
    evictSceneRef.current = evictScene;

    // Frame-slice until the near block is ready AND the LRU has evicted
    // (cached > lruCap with a non-active victim).
    let stats = evictStreamer.update(PX, PZ, 0);
    let frames = 0;
    while (evictedKeys.length === 0 || !evictStreamer.isReady(chunkKey(0, 0))) {
      if (++frames > MAX_WAIT_FRAMES) {
        throw new Error(
          `eviction wait stuck after ${MAX_WAIT_FRAMES} frames (cached=${stats.ready}, evicted=${evictedKeys.length})`,
        );
      }
      stats = evictStreamer.update(PX, PZ, 0);
    }
    expect(evictedKeys.length).toBeGreaterThan(0);

    // The evicted chunk is gone from the cache…
    for (const key of evictedKeys) expect(evictStreamer.getCached(key)).toBeUndefined();
    // …and the next sync agrees with the streamer's mountable set (which no
    // longer contains it): the merged groups carry the re-derived tally and
    // mesh count.
    const t = evictScene.sync(PX, PZ, 0);
    const exp = { near: 0, mid: 0, far: 0, mounted: 0 };
    const groupKeys = new Set<string>();
    for (const w of evictStreamer.mountable(PX, PZ, 0)) {
      const g =
        w.ring === 'near'
          ? w.entry.built.geometries.near
          : w.ring === 'mid'
            ? w.entry.built.geometries.mid
            : w.entry.built.geometries.far;
      if (!g) continue;
      exp[w.ring] += RING_TRIANGLES[w.ring];
      exp.mounted += 1;
      groupKeys.add(`${w.ring}:${w.entry.built.chunk?.biome ?? 'far'}`);
    }
    expect(t).toEqual(exp);
    expect(evictScene.mountedCount).toBe(exp.mounted);
    expect(meshes(evictScene)).toHaveLength(groupKeys.size);
    // Unknown keys are a no-op (the streamer owns disposal).
    expect(() => evictScene.handleEvict('999,999')).not.toThrow();
  });

  it('defers fresh near/mid chunks to the far quad while moving, then re-merges them once the burst drains', () => {
    warmToNearBlock();
    scene.sync(PX, PZ, 0);

    // Let cardinal chunk (2,0) finish — at 640 m from the player it is MID.
    let waitFrames = 0;
    while (!streamer.isReady(chunkKey(2, 0))) {
      if (++waitFrames > MAX_WAIT_FRAMES) {
        throw new Error(
          `deferral wait stuck after ${MAX_WAIT_FRAMES} frames: chunk (2,0) not ready (pending=${streamer.pendingCount})`,
        );
      }
      streamer.update(PX, PZ, 0);
    }

    // Moving player + a freshly scheduled streamer → every non-far chunk is
    // deferred to its far quad: one merged mesh per (biome) FAR group only,
    // each member a 2-tri impostor. The TALLY still follows the streamer's
    // real rings (the scene reports what the pipeline classifies).
    const t1 = scene.sync(PX, PZ, 120);
    const farKeys = new Set<string>();
    let mountable = 0;
    for (const w of streamer.mountable(PX, PZ, 0)) {
      const g =
        w.ring === 'near'
          ? w.entry.built.geometries.near
          : w.ring === 'mid'
            ? w.entry.built.geometries.mid
            : w.entry.built.geometries.far;
      if (!g) continue;
      mountable += 1;
      farKeys.add(`far:${w.entry.built.chunk?.biome ?? 'far'}`);
    }
    expect(t1.mid).toBeGreaterThan(0); // streamer classifies (2,0) as mid
    expect(scene.mountedCount).toBe(mountable); // every chunk is still mounted
    expect(meshes(scene)).toHaveLength(farKeys.size); // ...all as far quads
    const meshTotal = meshes(scene).reduce((a, m) => a + m.geometry.getIndex()!.count / 3, 0);
    expect(meshTotal).toBe(mountable * RING_TRIANGLES.far);

    // The player keeps moving; once the streamer has scheduled no new work
    // for enough consecutive frames the deferred chunks re-merge into their
    // real rings (one (ring, biome) group per sync) and the scene converges
    // back to the full merged contract.
    let frames = 0;
    for (;;) {
      streamer.update(PX, PZ, 0);
      scene.sync(PX, PZ, 120);
      if (++frames > 40) throw new Error(`deferral never converged after ${frames} syncs`);
      if (scene.meshCount === expectedMerged(PX, PZ).groupKeys.size) break;
    }
    const e2 = expectedMerged(PX, PZ);
    const t2 = scene.sync(PX, PZ, 0); // at rest: already converged
    expect(scene.meshCount).toBe(e2.groupKeys.size);
    expect(t2).toEqual(e2.exp);
    const total2 = meshes(scene).reduce((a, m) => a + m.geometry.getIndex()!.count / 3, 0);
    expect(total2).toBe(e2.exp.near + e2.exp.mid + e2.exp.far);
  });

  it('reports the per-ring tally to the monitor and the surface-tris gauge', () => {
    warmToNearBlock();
    const t = scene.sync(PX, PZ, 0);
    expect(monitor.getFrameStats().categoryTriangles).toEqual({
      'surface-near': t.near,
      'surface-mid': t.mid,
      'surface-far': t.far,
    });
    expect(monitor.getGaugeStats('surface-tris').limit).toBe(SURFACE_TRIANGLE_BUDGET);
  });
});
