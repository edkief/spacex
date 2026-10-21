/**
 * Frame loop driver — TASK-73.
 *
 * The single `requestAnimationFrame` loop that drives the entire
 * renderer. Lives in its own module so the React layer (`GameCanvas`)
 * owns the lifecycle and the test suite can drive the math
 * deterministically without a browser.
 *
 * Design rules from the spec:
 *   - **Fixed-step accumulator.** The simulation wants a
 *     deterministic timestep so an animation's "1 s" feels the
 *     same on a 60 Hz monitor and a 144 Hz monitor. We accumulate
 *     the real frame delta and fire `onFixedStep` every
 *     `fixedStepSeconds` (default 1/60) until the accumulator
 *     drains.
 *   - **`maxSubSteps` clamp.** A backgrounded tab returns from a
 *     10 s pause and tries to fire 600 catch-up steps in one
 *     frame. We cap at `maxSubSteps` (default 5) so a long pause
 *     cannot stall the rest of the pipeline.
 *   - **One loop per host.** React StrictMode double-mounts the
 *     component to catch effects that aren't idempotent. The
 *     loop guards on an instance-scoped flag so the second
 *     mount does NOT start a second rAF — the first loop stays
 *     the only owner of the canvas.
 *   - **Frame monitor integration.** Every animation frame feeds
 *     `FrameMonitor.recordFrameTime(now)` + `recordRendererInfo`
 *     so the rolling window reflects the frame it just drew.
 *   - **Host-driven render call.** The loop does NOT know how
 *     to render — the host owns its `render()` method, and the
 *     `onFrame` callback is the single place where that call
 *     lives. This keeps the loop module three.js-free.
 *
 * No React, no DOM beyond `requestAnimationFrame` / `cancelAnimationFrame`.
 */
import type { FrameMonitor } from "@client/perf/frameMonitor.js";

/** Default fixed step in seconds (60 Hz). */
export const DEFAULT_FIXED_STEP_SECONDS = 1 / 60;

/** Default catch-up cap. Five steps per animation frame at 60 Hz
 *  means up to 80 ms of catch-up — enough to recover from a
 *  janky frame but not so much that a backgrounded tab stalls the
 *  sim on return. */
export const DEFAULT_MAX_SUBSTEPS = 5;

/** Symbol used as a private flag on the host so a second
 *  `startFrameLoop(host)` call with the same host is a no-op. */
export const LOOP_GUARD_KEY: unique symbol = Symbol("drift.frameLoop.guard");

/** A host object the loop can drive. The host owns the renderer,
 *  scene, and rig — the loop only knows how to advance the
 *  accumulator and ask the host to read its counters. The actual
 *  `renderer.render(scene, camera)` call is the host's
 *  responsibility (or a `onFrame` callback's). */
export interface RenderHostLike {
  /** Bump `framesRendered` and read the renderer's per-frame
   *  counters in a single call. The loop reads the result for
   *  the FrameMonitor. */
  rendererInfo(): { drawCalls: number; triangles: number };
  /** Frames rendered since construction — bumped by the host's
   *  own `render()`. The loop never writes to this. */
  readonly framesRendered: number;
}

/** Options for {@link startFrameLoop}. */
export interface FrameLoopOptions {
  /** The host to drive. Required. */
  host: RenderHostLike;
  /** Fixed simulation step, seconds. Default 1/60. */
  fixedStepSeconds?: number;
  /** Maximum catch-up sub-steps per animation frame. Default 5. */
  maxSubSteps?: number;
  /** Called once per simulation step (after a successful
   *  `fixedStepSeconds` accumulation). Receives the **fixed**
   *  delta in seconds so simulation code is deterministic. */
  onFixedStep?: (dtSeconds: number) => void;
  /** Called once per animation frame (once per `rAF` tick).
   *  Receives the *real* wall-clock delta and the high-resolution
   *  `now` timestamp (`performance.now()`). Used by the host to
   *  call `renderer.render(scene, camera)` AFTER the catch-up
   *  drain. */
  onFrame?: (dtSeconds: number, nowMs: number) => void;
  /** Frame monitor to feed every animation frame. Defaults to
   *  `window.__driftFrameMonitor` if present; the loop records
   *  frames only when a monitor is supplied so unit tests can
   *  skip the side-effect. */
  frameMonitor?: FrameMonitor | null;
  /** Inject a clock for tests. Defaults to `performance.now()`. */
  now?: () => number;
  /** Inject an rAF scheduler. Defaults to
   *  `globalThis.requestAnimationFrame`. */
  raf?: (cb: (t: number) => void) => number;
  /** Inject a cAF scheduler. Defaults to
   *  `globalThis.cancelAnimationFrame`. */
  caf?: (handle: number) => void;
}

/** Handle returned by {@link startFrameLoop}. */
export interface FrameLoopHandle {
  /** True while the rAF loop is running. */
  readonly running: boolean;
  /** Stop the loop. No-op if already stopped. */
  stop(): void;
  /** Fixed step in seconds the loop is using. */
  readonly fixedStepSeconds: number;
  /** Maximum sub-steps the loop will run in a single catch-up
   *  burst. */
  readonly maxSubSteps: number;
}

/**
 * Start the rAF loop. The loop survives React StrictMode
 * double-mount: if a second `startFrameLoop` runs with the same
 * `host`, the second call returns a handle whose `stop()` is a
 * no-op (the first loop keeps running).
 */
export function startFrameLoop(opts: FrameLoopOptions): FrameLoopHandle {
  const fixedStepSeconds = opts.fixedStepSeconds ?? DEFAULT_FIXED_STEP_SECONDS;
  const maxSubSteps = opts.maxSubSteps ?? DEFAULT_MAX_SUBSTEPS;
  const raf = opts.raf ?? defaultRaf;
  const caf = opts.caf ?? defaultCaf;
  const now = opts.now ?? defaultNow;
  const monitor = opts.frameMonitor ?? null;

  // Guard against StrictMode double-mount: install a flag on the
  // host as a private symbol so two parallel `startFrameLoop`
  // calls can't both spawn rAFs.
  const hostInternal = opts.host as unknown as Record<symbol, boolean>;
  if (hostInternal[LOOP_GUARD_KEY] === true) {
    // Second mount — return a no-op handle. The first loop owns
    // the canvas.
    return {
      get running() {
        return true;
      },
      stop: () => {
        /* no-op: the first loop stays */
      },
      fixedStepSeconds,
      maxSubSteps,
    };
  }
  hostInternal[LOOP_GUARD_KEY] = true;

  let running = true;
  let rafHandle = 0;
  let lastNowMs = now();
  let accumulator = 0;

  const tick = (): void => {
    if (!running) return;
    // `frameNowMs` is the `DOMHighResTimeStamp` the browser
    // supplies. We still call `now()` for the sub-step clock
    // because some tests inject a fake clock and we want the
    // sub-step timestamps to come from the same source.
    const realNow = now();
    const dtReal = Math.max(0, (realNow - lastNowMs) / 1000);
    lastNowMs = realNow;
    accumulator += dtReal;

    // Drive the fixed-step simulation. Clamp the catch-up
    // window to `maxSubSteps` so a backgrounded tab cannot stall
    // the pipeline on return.
    let subSteps = 0;
    while (accumulator >= fixedStepSeconds && subSteps < maxSubSteps) {
      accumulator -= fixedStepSeconds;
      subSteps += 1;
      if (opts.onFixedStep !== undefined) {
        opts.onFixedStep(fixedStepSeconds);
      }
    }
    // Drop residual accumulation on the floor if we hit the cap —
    // keeping it would amplify the next-frame lag. The host will
    // catch up one step at a time from the next frame onward.
    if (subSteps >= maxSubSteps && accumulator >= fixedStepSeconds) {
      accumulator = 0;
    }

    // Per-animation-frame host work (camera smoothing, render,
    // etc.) lives entirely in `onFrame`. The host is expected to
    // call `renderer.render(scene, camera)` here and to update
    // its internal `framesRendered` counter.
    if (opts.onFrame !== undefined) {
      opts.onFrame(dtReal, realNow);
    }

    // Feed the frame monitor — one record per *animation* frame,
    // not per fixed step (the budget hooks care about wall-clock
    // time, not sim time).
    if (monitor !== null) {
      monitor.recordFrameTime(realNow);
      // Renderer info is captured by the host's `onFrame` via
      // `host.rendererInfo()`; the loop mirrors that here so
      // callers that own their own onFrame callback don't have
      // to remember to forward it.
      const info = opts.host.rendererInfo();
      monitor.recordRendererInfo({
        render: { calls: info.drawCalls, triangles: info.triangles },
      });
    }

    if (running) {
      rafHandle = raf(tick);
    }
  };

  rafHandle = raf(tick);

  return {
    get running() {
      return running;
    },
    stop: () => {
      if (!running) return;
      running = false;
      try {
        caf(rafHandle);
      } catch {
        // Cancel may throw if the host's rAF was injected with a
        // mismatch — swallow so the cleanup path stays quiet.
      }
      hostInternal[LOOP_GUARD_KEY] = false;
    },
    fixedStepSeconds,
    maxSubSteps,
  };
}

/**
 * Resize the host's canvas backing store and update the camera
 * rig's aspect ratio. Idempotent: repeated calls with the same
 * dimensions are cheap.
 *
 * The `setSize` shape is duck-typed — the loop module never
 * imports three.js directly. Any host with `renderer.setSize`
 * and a `cameraRig` with `setAspect` works.
 */
export function applyResize(
  host: { renderer: { setSize(w: number, h: number, updateStyle?: boolean): void } },
  cameraRig: { setAspect(aspect: number): void },
  cssWidth: number,
  cssHeight: number,
): void {
  const w = Math.max(1, Math.floor(cssWidth));
  const h = Math.max(1, Math.floor(cssHeight));
  host.renderer.setSize(w, h, false);
  cameraRig.setAspect(w / h);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Default `performance.now()` clock. Used when no `now` is supplied. */
function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function defaultRaf(cb: (t: number) => void): number {
  // The browser's rAF returns a numeric handle. We narrow to
  // `number` because every browser impl is one; Node + jsdom
  // provide one too.
  return globalThis.requestAnimationFrame(cb) as unknown as number;
}

function defaultCaf(handle: number): void {
  globalThis.cancelAnimationFrame(handle as unknown as ReturnType<typeof requestAnimationFrame>);
}
