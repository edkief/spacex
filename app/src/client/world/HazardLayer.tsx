/**
 * Hazard scope — TASK-48.
 *
 * Bottom-left HUD widget that draws the hazard cells (and the
 * drones inside them) around the player, spec-style:
 *
 *   - **Storm cells** — a violet disc with a rotating dashed
 *     swirl ring (the 2D stand-in for the "8 rotating quads"
 *     particle disc; the 3D renderer lands with TASK-26).
 *   - **Rad zones** — a green-glowing ground disc.
 *   - **Drone cells** — a red dashed ring, plus one small
 *     octahedron glyph per live drone inside the scope range.
 *
 * The scope is top-down: the player sits at the centre, `+x`
 * points right and `+z` points **up** (matching the surface
 * convention used by `playerHazardAnchor`). Only cells within
 * `HAZARD_VISIBLE_RANGE_M` (500 m) are drawn — the server
 * already culls to that range on the `hazard_update` frame, so
 * this component only clamps the drawing extent.
 *
 * Why SVG and not WebGL? The 3D surface renderer (TASK-26 chunk
 * pipeline) isn't wired yet, and a DOM scope is assertable from
 * unit tests + Playwright without a GL context. When the chunk
 * renderer lands, `projectToScope` is the seam that feeds the
 * ground-disc meshes.
 */
import { useSyncExternalStore } from "react";
import type * as React from "react";

import type { HazardCellMarker, HazardMarker, HazardStore } from "./hazards.js";
import { HAZARD_VISIBLE_RANGE_M } from "@shared/world/hazards.js";

// ---------------------------------------------------------------------------
// Public types + constants
// ---------------------------------------------------------------------------

export interface HazardLayerProps {
  /** Live hazard store. */
  store: HazardStore;
  /**
   * Override for the scope centre. Defaults to the anchor the
   * server pushed on the last `hazard_update` frame (falls back
   * to the world origin before the first frame lands).
   */
  ownWorldPos?: { x: number; y: number; z: number };
  /** Test seam — render with an empty scope. */
  initialEmpty?: boolean;
}

/** Scope diameter in CSS pixels. */
export const HAZARD_SCOPE_SIZE_PX = 168;

/** Scope radius in CSS pixels. */
export const HAZARD_SCOPE_RADIUS_PX = HAZARD_SCOPE_SIZE_PX / 2;

/**
 * World metres → scope pixels. Fixed so the 500 m ring always
 * sits exactly on the scope edge.
 */
export const HAZARD_SCOPE_PX_PER_M = HAZARD_SCOPE_RADIUS_PX / HAZARD_VISIBLE_RANGE_M;

/**
 * Project a world position onto the scope. Returns SVG
 * coordinates with the scope centre at
 * `(HAZARD_SCOPE_RADIUS_PX, HAZARD_SCOPE_RADIUS_PX)`; `+z`
 * (world forward) maps to screen **up** (`-y` in SVG).
 *
 * Pure — unit-tested directly so the renderer's math is pinned
 * without a DOM.
 */
export function projectToScope(
  pos: { x: number; z: number },
  origin: { x: number; z: number },
): { x: number; y: number } {
  return {
    x: HAZARD_SCOPE_RADIUS_PX + (pos.x - origin.x) * HAZARD_SCOPE_PX_PER_M,
    y: HAZARD_SCOPE_RADIUS_PX - (pos.z - origin.z) * HAZARD_SCOPE_PX_PER_M,
  };
}

/** Per-kind disc styling (fill, stroke, swirl flag). */
const KIND_STYLE: Record<
  HazardCellMarker["kind"],
  { fill: string; stroke: string; swirl: boolean }
> = {
  storm: { fill: "rgba(124, 92, 255, 0.22)", stroke: "#7c5cff", swirl: true },
  radzone: { fill: "rgba(52, 211, 153, 0.22)", stroke: "#34d399", swirl: false },
  drones: { fill: "rgba(255, 92, 92, 0.14)", stroke: "#ff5c5c", swirl: false },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Render the hazard scope. Returns `null` when there is nothing
 * to show (no cells and no drones in range), so the slot stays
 * invisible for players walking through safe ground.
 */
export function HazardLayer(props: HazardLayerProps): React.JSX.Element | null {
  const { store } = props;
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.snapshot(),
    () => store.snapshot(),
  );

  if (props.initialEmpty) return null;

  const origin = props.ownWorldPos ?? snapshot.anchor ?? { x: 0, y: 0, z: 0 };
  const cells = snapshot.cells;
  const drones = snapshot.markers;
  if (cells.length === 0 && drones.length === 0) return null;

  const cx = HAZARD_SCOPE_RADIUS_PX;
  const cy = HAZARD_SCOPE_RADIUS_PX;

  return (
    <div
      data-testid="drift-hazard-layer"
      data-cells={cells.length}
      data-drones={drones.length}
      style={{
        position: "fixed",
        // Sits above the "IN SYSTEM" presence panel (bottom: 16,
        // ~54 px tall) so the two HUD slots never overlap.
        bottom: 82,
        left: 16,
        width: HAZARD_SCOPE_SIZE_PX,
        padding: "6px 6px 4px",
        background: "rgba(20, 24, 32, 0.85)",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        borderRadius: 6,
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
        zIndex: 850,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      <svg
        data-testid="drift-hazard-scope"
        width={HAZARD_SCOPE_SIZE_PX}
        height={HAZARD_SCOPE_SIZE_PX}
        viewBox={`0 0 ${HAZARD_SCOPE_SIZE_PX} ${HAZARD_SCOPE_SIZE_PX}`}
      >
        <defs>
          {/* Rad-zone green glow. Single instance in the HUD, so a
              fixed id is fine. */}
          <radialGradient id="drift-hazard-radglow">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.75" />
            <stop offset="70%" stopColor="#34d399" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* 500 m range ring + crosshair. */}
        <circle
          cx={cx}
          cy={cy}
          r={HAZARD_SCOPE_RADIUS_PX - 2}
          fill="rgba(255, 255, 255, 0.03)"
          stroke="rgba(255, 255, 255, 0.18)"
          strokeWidth={1}
        />
        <line
          x1={cx}
          y1={4}
          x2={cx}
          y2={HAZARD_SCOPE_SIZE_PX - 4}
          stroke="rgba(255,255,255,0.07)"
        />
        <line
          x1={4}
          y1={cy}
          x2={HAZARD_SCOPE_SIZE_PX - 4}
          y2={cy}
          stroke="rgba(255,255,255,0.07)"
        />
        {cells.map((cell) => (
          <HazardCellGlyph key={cell.hazardId} cell={cell} origin={origin} />
        ))}
        {drones.map((marker) => (
          <DroneGlyph key={marker.id} marker={marker} origin={origin} />
        ))}
        {/* The player, at the scope centre. */}
        <circle data-testid="drift-hazard-self" cx={cx} cy={cy} r={3.5} fill="#7dd3fc" />
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          letterSpacing: "0.1em",
          color: "#9aa3ad",
        }}
      >
        <span>HAZARDS {HAZARD_VISIBLE_RANGE_M}m</span>
        {/* Back-compat readout: total visible hazard markers. */}
        <span data-testid="drift-hazard-count">{cells.length + drones.length}</span>
      </div>
    </div>
  );
}

/** Ground disc for one hazard cell, centred on the projected position. */
function HazardCellGlyph(props: {
  cell: HazardCellMarker;
  origin: { x: number; z: number };
}): React.JSX.Element {
  const { cell } = props;
  const at = projectToScope(cell.pos, props.origin);
  const style = KIND_STYLE[cell.kind];
  // Disc radius in pixels, clamped so a 400 m cell doesn't blow
  // out of the 168 px scope.
  const r = Math.max(6, Math.min(cell.radius * HAZARD_SCOPE_PX_PER_M, HAZARD_SCOPE_RADIUS_PX));
  return (
    <g data-testid={`drift-hazard-cell-${cell.kind}`} data-hazard-id={cell.hazardId}>
      <circle
        cx={at.x}
        cy={at.y}
        r={r}
        fill={cell.kind === "radzone" ? "url(#drift-hazard-radglow)" : style.fill}
        stroke={style.stroke}
        strokeWidth={1}
        strokeDasharray={cell.kind === "drones" ? "3 3" : undefined}
        opacity={0.9}
      />
      {style.swirl ? (
        // Rotating dashed ring — the "swirling particle disc".
        <circle
          className="drift-hazard-swirl"
          cx={at.x}
          cy={at.y}
          r={r * 0.7}
          fill="none"
          stroke={style.stroke}
          strokeWidth={1.5}
          strokeDasharray="8 10"
          strokeLinecap="round"
          opacity={0.85}
          style={{ transformOrigin: `${at.x}px ${at.y}px` }}
        />
      ) : null}
    </g>
  );
}

/** Small octahedron glyph for one live drone. */
function DroneGlyph(props: {
  marker: HazardMarker;
  origin: { x: number; z: number };
}): React.JSX.Element {
  const at = projectToScope(props.marker.pos, props.origin);
  const s = 4.5;
  // Octahedron silhouette = two triangles (top / bottom apex).
  const points = [
    `${at.x},${at.y - s}`,
    `${at.x + s},${at.y}`,
    `${at.x},${at.y + s}`,
    `${at.x - s},${at.y}`,
  ].join(" ");
  return (
    <g data-testid="drift-hazard-drone" data-drone-id={props.marker.id}>
      <polygon points={points} fill="rgba(255, 92, 92, 0.9)" stroke="#ffd0d0" strokeWidth={0.6} />
    </g>
  );
}
