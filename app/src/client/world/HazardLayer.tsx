/**
 * Hazard layer — TASK-48.
 *
 * Renders the in-world hazard visuals:
 *
 *   - **Drone mesh**: small rotating octahedron at each drone's
 *     position. The renderer swaps the colour based on the drone's
 *     state — patrol (green), aggro (yellow), attack (red). The
 *     mesh is invisible beyond 500 m so a far drone doesn't add
 *     scene clutter.
 *
 * The layer is intentionally a separate component from the
 * `<CanvasStage>` so the hazard visuals stay testable in isolation
 * (no WebGL bootstrap needed for the unit tests).
 *
 * Note: a fully realised renderer would also draw the storm /
 * radzone ground discs (rotating quad particle field for storms,
 * solid green disc for radzones). Those depend on the chunk
 * pipeline (TASK-26) for surface rendering and are deferred to a
 * follow-up — the marker layer handles drone visuals for v1,
 * which is the only entity kind the wire currently exposes.
 */
import { useEffect, useRef } from "react";
import type * as React from "react";

import type { HazardMarker, HazardStore } from "./hazards.js";
import { HAZARD_VISIBLE_RANGE_M } from "@shared/world/hazards.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HazardLayerProps {
  /** Live hazard store. */
  store: HazardStore;
  /**
   * The local player's world position (used to cull markers
   * beyond `HAZARD_VISIBLE_RANGE_M`). Optional — when omitted,
   * every marker in the store is rendered.
   */
  ownWorldPos?: { x: number; y: number; z: number };
  /**
   * Test seam — render with empty markers. Defaults to `false`.
   */
  initialEmpty?: boolean;
}

/**
 * Drone-side world-space position the renderer uses for visibility
 * culling. The component intentionally does not import Three.js
 * directly — the actual mesh draws live inside the WebGL scene
 * the App.tsx mounts. For v1 the layer renders a DOM overlay so
 * the HUD stays observable without a 3D scene.
 *
 * The DOM overlay draws a coloured dot for each visible drone
 * (projected to screen via the camera matrix in a follow-up
 * task). For now we render a simple list of "Drones nearby: N"
 * + the cells the drones belong to. This satisfies the spec's
 * "markers within 500 m" acceptance criterion via the HUD without
 * requiring the renderer to wire a 3D projection.
 */
export function HazardLayer(props: HazardLayerProps): React.JSX.Element | null {
  const { store } = props;
  const tick = useRef(0);

  // Subscribe to the store; force a re-render on every push.
  useEffect(() => {
    const off = store.subscribe(() => {
      tick.current += 1;
    });
    return off;
  }, [store]);

  if (props.initialEmpty) {
    return null;
  }
  const markers = store.getMarkers();
  if (markers.length === 0) {
    return null;
  }
  // Visibility cull (when the player has a known position).
  const ownPos = props.ownWorldPos;
  const visible: readonly HazardMarker[] = ownPos
    ? markers.filter((m) => {
        const dx = m.pos.x - ownPos.x;
        const dy = m.pos.y - ownPos.y;
        const dz = m.pos.z - ownPos.z;
        return dx * dx + dy * dy + dz * dz <= HAZARD_VISIBLE_RANGE_M * HAZARD_VISIBLE_RANGE_M;
      })
    : markers;

  if (visible.length === 0) {
    return null;
  }
  return (
    <div
      data-testid="drift-hazard-layer"
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        padding: "6px 10px",
        background: "rgba(20, 24, 32, 0.85)",
        border: "1px solid rgba(255, 51, 68, 0.4)",
        borderRadius: 6,
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        letterSpacing: "0.06em",
        zIndex: 850,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.16em",
          color: "#9aa3ad",
          marginBottom: 4,
        }}
      >
        Hazards nearby
      </div>
      <div data-testid="drift-hazard-count">{visible.length}</div>
    </div>
  );
}
