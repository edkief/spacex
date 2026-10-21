/**
 * Render host — TASK-73.
 *
 * The single owner of the client-side three.js state. Owns:
 *   - One `THREE.WebGLRenderer` (created with `antialias: true,
 *     preserveDrawingBuffer: true` so the e2e harness's
 *     `sampleCanvasPixels` 2-D readback returns real pixels).
 *   - One `THREE.Scene` (clear colour is the same deep navy the
 *     TASK-70 starfield used).
 *   - One `CameraRig` from `@client/camera` (the camera the
 *     renderer mounts in the scene).
 *   - The deterministic `Points` starfield mesh, parented once
 *     at construction time. Counts toward `sceneChildCount`.
 *
 * The class is deliberately plain TS (no React). The React layer
 * (`GameCanvas`) instantiates it inside `useEffect` and tears it
 * down on unmount. The frame loop (in `loop.ts`) drives it.
 *
 * Lifetime:
 *   1. `new RenderHost({ canvas, aspect, quality })` — constructs
 *      the renderer, scene, rig + starfield.
 *   2. The loop calls `host.render()` once per animation frame
 *      (see `GameCanvas`).
 *   3. `host.setSize(cssW, cssH)` updates the renderer's backing
 *      store and the rig's aspect ratio on resize.
 *   4. `host.dispose()` releases all GPU resources.
 *
 * Debug seam: `window.__driftRenderHost` is installed in the
 * production bundle via the `GameCanvas` mount so the e2e gate
 * can read `framesRendered`, `rendererInfo()` and `sceneChildCount`.
 *
 * @see ./loop.ts        — frame loop driver.
 * @see ./background.ts  — the deterministic starfield mesh.
 * @see ./GameCanvas.tsx — the React component that owns this.
 */
import { Color, type PerspectiveCamera, Scene, WebGLRenderer } from "three";

import { CameraRig } from "@client/camera/CameraRig.js";
import type { QualityPreset } from "@shared/settings.js";
import { QUALITY_PRESETS } from "@shared/settings.js";

import { createStarfield, disposeStarfield } from "./background.js";
import { createSceneLighting } from "./lighting.js";

/**
 * Deep-navy clear colour from
 * `components/CanvasStage.tsx#CLEAR_COLOR`. Kept as a constant
 * here so the renderer's "background is dark" promise doesn't
 * require reaching into the legacy CanvasStage stub.
 */
export const RENDER_HOST_CLEAR_COLOR: readonly [number, number, number, number] = [
  0.02, 0.025, 0.04, 1.0,
];

/**
 * Capped device-pixel-ratio. 2 keeps the harness sharp on hi-DPI
 * displays without paying for 4× pixels; the same value the
 * TASK-70 starfield used.
 */
const DPR_CAP = 2;

/** Options for {@link RenderHost}. */
export interface RenderHostOptions {
  /** The canvas the renderer attaches to. Required. */
  canvas: HTMLCanvasElement;
  /** Initial viewport aspect (width / height). */
  aspect: number;
  /** Quality preset — the only renderer-tunable we read at
   *  construction time. Future preset switches call
   *  `setQuality()` instead of rebuilding. */
  quality: QualityPreset;
  /** Optional explicit DPR — test seam. Defaults to
   *  `Math.min(2, window.devicePixelRatio || 1)`. */
  devicePixelRatio?: number;
  /** TASK-75: live count of pooled remote-entity meshes. The
   *  render host does not own them (the `RemoteEntityLayer`
   *  does) but the e2e seam
   *  `window.__driftRenderHost.remoteMeshCount()` reads the
   *  number from here. */
  remoteMeshCount?: () => number;
  /** TASK-76: live count of rendered system bodies (star +
   *  planets). Owned by the `SystemBodyLayer`, surfaced here so
   *  the e2e seam can read `bodyCount()` off the same host. */
  bodyCount?: () => number;
}

/**
 * One-time slice of the renderer's per-frame counters. Mirrors
 * the structure `FrameMonitor.recordRendererInfo` expects.
 */
export interface RendererInfoSlice {
  drawCalls: number;
  triangles: number;
}

/**
 * The single client-side render host. Decoupled from React.
 */
export class RenderHost {
  /** The canvas the renderer was attached to. */
  readonly canvas: HTMLCanvasElement;
  /** The single renderer. */
  readonly #renderer: WebGLRenderer;
  /** The single scene. */
  readonly #scene: Scene;
  /** The single camera rig (rig owns the perspective camera). */
  readonly #cameraRig: CameraRig;
  /** Number of animation frames the host has rendered since
   *  construction. Bumped externally by the loop's `onFrame`. */
  framesRendered = 0;
  /** The device pixel ratio the renderer was constructed with. */
  readonly dpr: number;
  /** Active quality preset (drives future density knobs). */
  #quality: QualityPreset;
  /** Disposed flag — prevents double-disposal during StrictMode
   *  teardown races. */
  #disposed = false;
  /** TASK-75: remote-mesh counter provider (see
   *  `RenderHostOptions.remoteMeshCount`). */
  readonly #remoteMeshCount: () => number;
  /** TASK-76: system-body counter provider (see
   *  `RenderHostOptions.bodyCount`). */
  readonly #bodyCount: () => number;

  constructor(opts: RenderHostOptions) {
    this.canvas = opts.canvas;
    this.#remoteMeshCount = opts.remoteMeshCount ?? ((): number => 0);
    this.#bodyCount = opts.bodyCount ?? ((): number => 0);
    this.#quality = opts.quality;
    this.dpr = clampDpr(opts.devicePixelRatio ?? readDefaultDpr());
    // Construct the renderer with `preserveDrawingBuffer: true`.
    // The TASK-73 e2e harness (`sampleCanvasPixels`) draws the
    // live canvas into a 2-D scratch canvas and reads back via
    // `getImageData` — without this flag the browser's swap
    // chain would hand a black 2-D context back to the test.
    this.#renderer = new WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      // The pixel readback seam from TASK-70 / TASK-77. Required.
      preserveDrawingBuffer: true,
      // The harness can render against a hardware canvas; tell
      // three.js to keep things deterministic + skip a depth
      // buffer that the background-only scene does not need.
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
    this.#renderer.setPixelRatio(this.dpr);
    // The renderer's intrinsic size has to match the canvas's
    // CSS box or the first frame is a stretched black rectangle.
    // We rebuild the canvas's backing-store size here; the React
    // layer's `setSize` keeps them in sync on resize.
    const initialWidth = Math.max(1, opts.canvas.clientWidth || Math.floor(windowInnerWidth()));
    const initialHeight = Math.max(1, opts.canvas.clientHeight || Math.floor(windowInnerHeight()));
    this.#renderer.setSize(initialWidth, initialHeight, false);

    // The single scene + the same deep navy clear colour the
    // TASK-70 starfield used. The background is a flat clear
    // colour now; the starfield is a child object added below.
    this.#scene = new Scene();
    const [cr, cg, cb] = RENDER_HOST_CLEAR_COLOR;
    this.#scene.background = new Color(cr, cg, cb);

    // The single camera rig — owned by the host, not by React.
    // The rig owns the `PerspectiveCamera` we mount in the
    // scene below.
    this.#cameraRig = new CameraRig({ aspect: opts.aspect });

    // The deterministic starfield (TASK-70 ported). Added as the
    // scene's first child so `sceneChildCount >= 1` is true the
    // moment after construction.
    const stars = createStarfield(this.dpr);
    this.#scene.add(stars);

    // TASK-75: solid meshes (own ship, pooled remote entities) use
    // `MeshStandardMaterial` and render pure black without a light.
    // The rig is cheap (no shadows) and mounted once.
    this.#scene.add(createSceneLighting());

    // The camera has to be added to the scene too, otherwise
    // three.js can drop child-of-perspectiveCamera helpers in a
    // future task. The rig's `perspectiveCamera` is the mount
    // point.
    this.#scene.add(this.#cameraRig.perspectiveCamera);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** The scene the renderer mounts. */
  get scene(): Scene {
    return this.#scene;
  }

  /** The single perspective camera the renderer renders with. */
  get camera(): PerspectiveCamera {
    return this.#cameraRig.perspectiveCamera;
  }

  /** The camera rig — the loop calls `rig.update(dt)` per fixed
   *  step so smoothing + handoffs run. */
  get cameraRig(): CameraRig {
    return this.#cameraRig;
  }

  /**
   * TASK-75: visible pooled remote-entity meshes. Production
   * wires the `RemoteEntityLayer` in through the constructor
   * option; with no layer the count is always 0.
   */
  remoteMeshCount(): number {
    return this.#remoteMeshCount();
  }

  /**
   * TASK-76: rendered system bodies (the star + its planets) for
   * the system the client is currently in. `0` until the galaxy
   * seed resolves and the layer rebuilds.
   */
  bodyCount(): number {
    return this.#bodyCount();
  }

  /** The single renderer instance. Most production code goes
   *  through `render()`; tests + the debug overlay read this
   *  directly. */
  get renderer(): WebGLRenderer {
    return this.#renderer;
  }

  /** Active quality preset. */
  get quality(): QualityPreset {
    return this.#quality;
  }

  /** Replace the active preset without rebuilding the renderer.
   *  Star count, FX caps etc. flip on the next frame; geometry
   *  caches are not invalidated (LOD re-tunes lazily). */
  setQuality(quality: QualityPreset): void {
    this.#quality = quality;
  }

  /** Active star count from the preset table (read-only surface —
   *  the future starfield task uses this to rebuild on preset flip). */
  starCount(): number {
    return QUALITY_PRESETS[this.#quality].starCount;
  }

  /**
   * Resize the renderer backing store + the rig's aspect ratio
   * to match the canvas's CSS box. `setSize(w, h, false)` keeps
   * the CSS layout untouched (the canvas's `100vw / 100vh`
   * style handles layout) and only updates the GL viewport.
   */
  setSize(cssWidth: number, cssHeight: number): void {
    const w = Math.max(1, cssWidth);
    const h = Math.max(1, cssHeight);
    this.#renderer.setSize(w, h, false);
    this.#cameraRig.setAspect(w / h);
  }

  /**
   * Snapshot the renderer's per-frame counters (a thin slice of
   * `renderer.info.render`). Cheap; this is the seam the
   * FrameMonitor reads and that the e2e harness asserts on.
   */
  rendererInfo(): RendererInfoSlice {
    const info = this.#renderer.info.render;
    return { drawCalls: info.calls, triangles: info.triangles };
  }

  /** Number of children in the scene. The e2e harness asserts
   *  this is >= 1 (the starfield). */
  sceneChildCount(): number {
    return this.#scene.children.length;
  }

  /**
   * Per-frame render entry point. Owning code (the loop) is
   * expected to call this once per animation frame; the host
   * itself does NOT start a rAF so React StrictMode double-mount
   * can dispose cleanly between mounts. Bumps `framesRendered`.
   */
  render(): void {
    this.#renderer.render(this.#scene, this.#cameraRig.perspectiveCamera);
    this.framesRendered += 1;
  }

  /**
   * Dispose of GPU resources. After `dispose()` the host is
   * unusable — construct a fresh one for the next mount.
   *
   * Disposes:
   *   - All geometry/material allocated by the starfield.
   *   - The renderer (releases its WebGL context + GL buffers).
   *
   * Idempotent: a second call is a no-op.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Walk the scene's children and dispose the starfield's
    // GPU-bound objects. The future Tasks 74/75/76 add their
    // own dispose-by-iteration so this stays scoped to the
    // background for now.
    for (const child of [...this.#scene.children]) {
      if (child === this.#cameraRig.perspectiveCamera) continue;
      disposeStarfield(child);
      this.#scene.remove(child);
    }
    this.#renderer.dispose();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Clamp the device pixel ratio into [1, DPR_CAP]. */
function clampDpr(dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(DPR_CAP, dpr);
}

/** Read the default DPR from the browser, falling back to 1 in
 *  non-browser environments. */
function readDefaultDpr(): number {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio ?? 1;
  return clampDpr(dpr);
}

/** Best-effort `window.innerWidth` that never throws in headless
 *  tests. */
function windowInnerWidth(): number {
  if (typeof window === "undefined") return 1;
  return window.innerWidth || 1;
}
function windowInnerHeight(): number {
  if (typeof window === "undefined") return 1;
  return window.innerHeight || 1;
}
