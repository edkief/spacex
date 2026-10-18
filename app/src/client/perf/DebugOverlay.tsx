/**
 * Debug overlay (TASK-57) — dev-only on-screen frame monitor.
 *
 * Reads a `FrameMonitor` at 2 Hz (no per-frame re-render — at 60
 * fps a 60 Hz render of this panel would dominate the perf
 * signal). Renders into the top-right corner above the canvas.
 * Hidden in production builds: the file is imported only by
 * `App.tsx` behind `import.meta.env.DEV`, so Vite tree-shakes the
 * entire module out of production.
 *
 * Layout:
 *   - Position `absolute; top: 16; right: 16` so it sits above the
 *     StarChart overlay (which fills the viewport) and stacks
 *     with the toasts.
 *   - Monospace font so columns line up regardless of length.
 *   - Semi-transparent background so the overlay is legible on
 *     both starfields and warp gradients without occluding too
 *     much of the canvas.
 *   - Compact columns (FPS / frame / draws / tris / entities) —
 *     matches the in-game "diagnostic" feel of the spec.
 *
 * Why not behind an `import.meta.env.DEV` *here*?
 *   - Vite is smart enough to detect the guard in `App.tsx` and
 *     strip this module + frameMonitor entirely. Putting the
 *     guard in `App.tsx` keeps the overlay code unconditional
 *     so unit tests can render it under Node without a Vite
 *     build step.
 */

import { useEffect, useState } from "react";
import type * as React from "react";

import type { FrameMonitor, FrameStats } from "./frameMonitor.js";

/** Sample interval (ms). The spec asks for "no per-frame re-render" —
 *  the overlay reads the monitor 5× a second so its own contribution
 *  to the rendered frame budget is invisible next to the canvas work. */
const POLL_INTERVAL_MS = 500;

/** Props for the overlay. The host owns the `open` flag (driven by
 *  the F3 keybind via `App.tsx`) so the overlay can be mounted
 *  unconditionally without re-subscribing to the monitor. */
export interface DebugOverlayProps {
  monitor: FrameMonitor;
  /** Whether the overlay is currently visible. */
  open: boolean;
}

/** A debug overlay panel reading from a `FrameMonitor`. */
export function DebugOverlay({ monitor, open }: DebugOverlayProps): React.JSX.Element | null {
  const [stats, setStats] = useState<FrameStats>(() => monitor.getFrameStats());

  useEffect(() => {
    if (!open) return;
    // The 2 Hz poll interval keeps the panel from re-rendering
    // each frame. We pull the latest stats snapshot into local
    // state so React's renderer never sees a per-frame update.
    const id = window.setInterval(() => {
      setStats(monitor.getFrameStats());
    }, POLL_INTERVAL_MS);
    // Pull one snapshot immediately so the panel isn't blank
    // for the first 500 ms after the toggle.
    setStats(monitor.getFrameStats());
    return () => {
      window.clearInterval(id);
    };
  }, [open, monitor]);

  if (!open) return null;

  return (
    <div
      data-testid="drift-debug-overlay"
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        padding: "8px 10px",
        background: "rgba(8, 12, 18, 0.78)",
        color: "#9aa3ad",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        borderRadius: 4,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 11,
        letterSpacing: "0.04em",
        lineHeight: 1.4,
        minWidth: 168,
        pointerEvents: "none",
        zIndex: 1500,
      }}
    >
      <div
        data-testid="drift-debug-overlay-header"
        style={{
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "rgba(255, 255, 255, 0.55)",
          marginBottom: 4,
        }}
      >
        Debug (F3)
      </div>
      <Stat label="FPS" value={stats.fps.toFixed(1)} accent={fpsAccent(stats.fps)} />
      <Stat label="frame ms" value={stats.frameTimeMs.toFixed(2)} />
      <Stat label="p50" value={`${stats.p50.toFixed(2)} ms`} />
      <Stat label="p95" value={`${stats.p95.toFixed(2)} ms`} accent={p95Accent(stats.p95)} />
      <Stat label="p99" value={`${stats.p99.toFixed(2)} ms`} accent={p99Accent(stats.p99)} />
      <Stat label="draws" value={stats.drawCalls.toString()} />
      <Stat
        label="tris"
        value={stats.triangles.toLocaleString("en-US", { maximumFractionDigits: 0 })}
      />
      <Stat label="ents" value={stats.entities.toString()} />
      <div
        data-testid="drift-debug-overlay-window"
        style={{ marginTop: 4, fontSize: 9, color: "rgba(255, 255, 255, 0.45)" }}
      >
        {stats.windowSize}/300 frames
      </div>
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
  /** Optional colour override — used to flag frames over budget. */
  accent?: string;
}

function Stat({ label, value, accent }: StatProps): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ color: "rgba(255, 255, 255, 0.55)" }}>{label}</span>
      <span style={{ color: accent ?? "#e6edf3" }}>{value}</span>
    </div>
  );
}

/** FPS colour — dim red if we're below 30 fps, dim yellow under 50,
 *  green-ish otherwise. Visual aid for the "is this slow?" question. */
function fpsAccent(fps: number): string {
  if (fps < 30) return "rgba(248, 81, 73, 0.95)";
  if (fps < 50) return "rgba(255, 191, 0, 0.95)";
  return "#56d364";
}

/** p95 colour — flag if p95 frame time exceeds 16.67 ms (60 fps budget). */
function p95Accent(p95: number): string {
  if (p95 > 33) return "rgba(248, 81, 73, 0.95)";
  if (p95 > 16.67) return "rgba(255, 191, 0, 0.95)";
  return "#e6edf3";
}

function p99Accent(p99: number): string {
  if (p99 > 50) return "rgba(248, 81, 73, 0.95)";
  return "#e6edf3";
}
