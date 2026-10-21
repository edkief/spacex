/**
 * GameCanvas — TASK-73.
 *
 * The single React component that owns the `RenderHost`. Replaces
 * the legacy `<CanvasStage>` starfield stub with a real three.js
 * mount: `<canvas id="drift-canvas" data-testid="drift-canvas"
 * role="img" aria-label={...}>` is the same DOM node the e2e
 * harness + the a11y spec already pin, so the visual contract
 * doesn't change.
 *
 * Lifecycle:
 *   1. On mount, construct a `RenderHost`, install it on
 *      `window.__driftRenderHost`, and start the frame loop.
 *   2. On unmount, stop the loop and dispose the host. The
 *      strict-mode double-mount is guarded by:
 *        - `RenderHost.dispose()` is idempotent.
 *        - `startFrameLoop(host)` returns a no-op handle the
 *          second time (LOOP_GUARD_KEY).
 *   3. A `ResizeObserver` keeps the renderer backing store in
 *      sync with the canvas's CSS box. The first observation
 *      also runs a one-shot fit so the canvas starts at its
 *      real on-screen size.
 *
 * No state — the host is plain TS, the loop owns its own ticks.
 */
import * as React from "react";
import { useEffect, useRef } from "react";

import { type FrameMonitor } from "@client/perf/frameMonitor.js";
import { settingsBridge } from "@client/world/settingsBridge.js";

import { RenderHost } from "./RenderHost.js";
import { LOOP_GUARD_KEY, applyResize, startFrameLoop, type FrameLoopHandle } from "./loop.js";

/** Property shape for {@link GameCanvas}. */
export interface GameCanvasProps {
  /**
   * TASK-54: the accessible name for the canvas. Same default
   * the TASK-70 stub used so the a11y spec keeps passing.
   */
  label?: string;
}

/**
 * Default `FrameMonitor` accessor. Reads from
 * `window.__driftFrameMonitor` if installed (production: yes
 * via `useClientWiring`; the wiring also ensures the monitor
 * exists before the renderer starts). Returns `null` in
 * non-browser environments so unit tests don't blow up.
 */
function readFrameMonitor(): FrameMonitor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __driftFrameMonitor?: FrameMonitor };
  return w.__driftFrameMonitor ?? null;
}

/**
 * The Drift main canvas — TASK-73 mount.
 *
 * One `<canvas>` per game session. React only manages the DOM
 * node and the lifecycle `useEffect`; every per-frame concern
 * (camera, scene, render) is owned by the `RenderHost` instance
 * the effect creates.
 */
export function GameCanvas(props: GameCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<RenderHost | null>(null);
  const loopRef = useRef<FrameLoopHandle | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Defensive: clear any stale guard from a previous StrictMode
    // mount that didn't reach its cleanup before this one starts.
    // (The loop module sets this exact key, so removing first
    // guarantees the new mount owns its loop.)
    const hostInternal = RenderHost.prototype as unknown as Record<symbol, boolean>;
    hostInternal[LOOP_GUARD_KEY] = false;

    // Build the host. The aspect is a placeholder for the very
    // first frame — we re-set it immediately after mount when
    // the ResizeObserver fires with the real on-screen size.
    const initialWidth = canvas.clientWidth || window.innerWidth || 1;
    const initialHeight = canvas.clientHeight || window.innerHeight || 1;
    const host = new RenderHost({
      canvas,
      aspect: initialWidth / initialHeight,
      quality: settingsBridge.quality(),
    });
    hostRef.current = host;

    // Install the debug seam so the e2e harness can read
    // framesRendered / rendererInfo / sceneChildCount. The App
    // tree installs `window.__driftClient` and the monitor; this
    // matches that precedent (production install).
    (globalThis as { __driftRenderHost?: RenderHost }).__driftRenderHost = host;

    // Hook resize. A ResizeObserver covers CSS-driven resizes
    // (e.g. window resize, dev-tools panel toggles); a fallback
    // `window.resize` listener covers browsers without RO. We
    // also fire one initial fit because the canvas's
    // `clientWidth` may not yet reflect its CSS box on the very
    // first effect call.
    const fit = (): void => {
      const rect = canvas.getBoundingClientRect();
      host.setSize(rect.width, rect.height);
    };
    fit();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(canvas);
    window.addEventListener("resize", fit);
    void applyResize; // keep the named helper; the host owns resize.

    // Start the loop. The monitor is read each tick by the loop
    // itself (no per-frame closure churn).
    const loop = startFrameLoop({
      host,
      fixedStepSeconds: 1 / 60,
      maxSubSteps: 5,
      onFixedStep: (dt) => {
        host.cameraRig.update(dt);
      },
      onFrame: (_dt, _now) => {
        host.render();
      },
      frameMonitor: readFrameMonitor(),
    });
    loopRef.current = loop;

    return (): void => {
      // StrictMode second-unmount path: stop the loop first so
      // rAF callbacks no longer reach into a torn-down host.
      loopRef.current?.stop();
      loopRef.current = null;
      ro?.disconnect();
      window.removeEventListener("resize", fit);
      // dispose() is idempotent — safe under StrictMode's
      // double-mount race.
      hostRef.current?.dispose();
      hostRef.current = null;
      if ((globalThis as { __driftRenderHost?: RenderHost }).__driftRenderHost === host) {
        (globalThis as { __driftRenderHost?: RenderHost }).__driftRenderHost = undefined;
      }
      hostInternal[LOOP_GUARD_KEY] = false;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      id="drift-canvas"
      data-testid="drift-canvas"
      role="img"
      aria-label={props.label ?? "3D view: flying in space"}
      style={{ display: "block", width: "100vw", height: "100vh" }}
    />
  );
}
