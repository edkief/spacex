/**
 * TASK-26.2: dev-only draw-distance budget benchmark hook.
 *
 * Exposes `window.__STREAM__` on the page so the e2e spec can render the
 * 13-chunk default-LOD benchmark scene (resting player: 9 near + 4 mid)
 * through a real THREE.WebGLRenderer and read
 * `renderer.info.render.triangles` — the AC4 measurement vitest's
 * GL-less environment cannot make.
 *
 * Like `__DRIFT__` (drift-debug.ts), it is only installed when
 * `import.meta.env.DEV` is true, so production builds never ship it. The
 * seed comes from `__DRIFT__` (the server-provided seed via /api/health),
 * so the benchmark walks the same derivation path as the rest of the e2e
 * suite. The renderer is disposed before returning so the page never
 * leaks a WebGL context (headless Chromium caps contexts per page).
 */

import * as THREE from 'three';
import { FrameMonitor } from '@client/perf/frameMonitor';
import { activeSet, chunkKey, ChunkStreamer } from '@client/world/chunks';
import { ChunkScene, type SceneTriangleStats } from '@client/world/chunk-scene';
import { generateSystem } from '@shared/galaxy/system';
import devSeed from '@shared/galaxy/__fixtures__/surface-dev-seed-chunk00.json';

/** Resting player position: the center of chunk (0,0). */
const REST_X = 160;
const REST_Z = 160;
/** Warm-loop frame cap — fail fast instead of hanging the e2e run. */
const MAX_WARM_FRAMES = 600;

/** Result of one benchmark-scene render (what the e2e spec asserts). */
export interface StreamBenchmarkResult {
  /** renderer.info.render.triangles of the single rendered frame. */
  totalTris: number;
  /** Per-ring tally of the mounted scene (excludes unmounted impostors). */
  perRing: SceneTriangleStats;
  /** Active chunks of the 13-chunk resting set that are ready. */
  readyChunks: number;
}

/** Shape of the debug surface the e2e tests read. */
export interface StreamDebug {
  /** Render the 13-chunk default-LOD benchmark scene, report, dispose. */
  surfaceBenchmark(): StreamBenchmarkResult;
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __STREAM__?: StreamDebug;
  }
}

/**
 * Install the hook on window. No-op in production builds (DEV flag false).
 * Called once at module load from main.tsx.
 */
export function installStreamDebug(): void {
  if (!import.meta.env.DEV) return;
  window.__STREAM__ = { surfaceBenchmark: () => surfaceBenchmark() };
}

/**
 * Build the benchmark scene: warm the real scheduler at the resting
 * position until the full 13-chunk active set is ready, mount it in a
 * ChunkScene reporting to a FRESH FrameMonitor (not the app-wide
 * singleton), and render one frame with a detached-canvas renderer whose
 * top-down camera sees the whole 5x5 chunk span.
 */
function surfaceBenchmark(): StreamBenchmarkResult {
  const seed = window.__DRIFT__?.seed;
  if (!seed) throw new Error('__STREAM__: server seed not ready (via __DRIFT__)');
  const planet = generateSystem(seed, devSeed.starId).planets[devSeed.planetIndex];
  const streamer = new ChunkStreamer(seed, planet);
  const active = activeSet(REST_X, REST_Z, 0);

  try {
    // Warm loop: the real 4 ms/frame scheduler at rest, frame-capped.
    for (let frame = 0; frame < MAX_WARM_FRAMES; frame++) {
      streamer.update(REST_X, REST_Z, 0);
      if (active.every((a) => streamer.isReady(chunkKey(a.chunkX, a.chunkZ)))) break;
      if (frame === MAX_WARM_FRAMES - 1) {
        const ready = countReady(streamer, active);
        throw new Error(
          `__STREAM__: only ${ready}/${active.length} active chunks ready after ${MAX_WARM_FRAMES} frames`,
        );
      }
    }
    const readyChunks = countReady(streamer, active);

    const monitor = new FrameMonitor();
    const scene = new ChunkScene(streamer, { monitor });
    try {
      const perRing = scene.sync(REST_X, REST_Z, 0);

      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
      try {
        const threeScene = new THREE.Scene();
        threeScene.add(scene.group);
        const camera = new THREE.PerspectiveCamera(60, 1, 1, 20_000);
        // Top-down over the 5x5 span (player chunk at origin): every
        // mounted chunk passes the frustum test, so renderer.info counts
        // the whole benchmark scene.
        camera.position.set(800, 3000, 800);
        camera.lookAt(800, 0, 800);
        renderer.render(threeScene, camera);
        const totalTris = renderer.info.render.triangles;
        threeScene.dispose();
        return { totalTris, perRing, readyChunks };
      } finally {
        renderer.dispose();
      }
    } finally {
      scene.dispose();
    }
  } finally {
    streamer.reset(); // dispose all chunk geometries
  }
}

function countReady(streamer: ChunkStreamer, active: ReturnType<typeof activeSet>): number {
  return active.filter((a) => streamer.isReady(chunkKey(a.chunkX, a.chunkZ))).length;
}
