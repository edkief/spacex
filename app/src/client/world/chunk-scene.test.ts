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

describe('ChunkScene (TASK-26 step 2)', () => {
  let monitor: FrameMonitor;
  let warned: string[];
  let streamer: ChunkStreamer;
  let scene: ChunkScene;

  beforeEach(() => {
    monitor = new FrameMonitor(); // fresh instance — never the app-wide singleton
    warned = [];
    setPerfLogSink((message) => warned.push(message));
    streamer = new ChunkStreamer(SEED, PLANET, {});
    scene = new ChunkScene(streamer, { monitor });
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
