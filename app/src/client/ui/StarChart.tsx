/**
 * StarChart — TASK-7 in-game chart UI.
 *
 * Renders a deterministic DOM/SVG galaxy map of every system
 * (sourced from `GET /api/galaxy/overview`) with edges labeled
 * with light-second distances + warp time. Live occupancy is
 * polled from `GET /api/galaxy/health` every 5 s while the chart
 * is open; the local player's system is highlighted; clicking
 * another system selects it and enables a "Warp" button showing
 * the estimated travel time.
 *
 * ## Accessibility
 *
 * Every star node is a focusable `<g role="button" tabIndex={0}>`
 * with keyboard handlers for `Enter`/`Space` to select. The Warp
 * button is a real `<button>` with an `aria-label` that reads
 * "Warp to <name>, <N> seconds". `Escape` closes the chart.
 *
 * ## Determinism
 *
 * The chart layout is computed by the server (projected 2-D
 * coordinates in the overview payload). The component itself
 * does no projection math at render time, so two browsers that
 * fetch the same `/api/galaxy/overview` response produce
 * byte-equal SVG output. The screenshot test (see
 * `tests/e2e/star-chart.spec.ts`) exploits this property.
 *
 * ## Polling lifecycle
 *
 * `useEffect` runs the 5 s interval; cleanup clears it on
 * unmount AND on `open=false`. Polling is gated on `open` so
 * closing the chart from anywhere (Escape, close button) stops
 * the requests immediately.
 *
 * ## Warp handoff (TASK-7 → TASK-8)
 *
 * The chart never sends the WS `warp` frame itself — it just
 * invokes `onWarp(targetId)` when the Warp button is clicked.
 * TASK-8 wires `onWarp` to the warp flow (state machine in
 * `state/warp.ts` + WS send). For TASK-7 the prop is optional
 * (defaults to a no-op so non-WS tests can render the chart).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type * as React from "react";

import type { GalaxyOverview, OverviewSystemNode } from "@shared/galaxy/overview.js";
import type { SpectralClass } from "@shared/galaxy/types.js";
import { isWarpInFlight, type WarpStore } from "../state/warp.js";

// ---------------------------------------------------------------------------
// Spectral class colours
// ---------------------------------------------------------------------------

/**
 * Hex fill colours for the seven spectral classes. Picked so:
 *   - the chart reads as a colour-coded map at a glance
 *   - O-class stars stand out as the rarest
 *   - all colours are legible against the deep-navy backdrop
 *
 * Tuned for the canvas (`#05060a`); the contrast ratio against
 * `#e6edf3` text is > 4.5:1 for all seven (TASK-54 a11y bar).
 */
export const STAR_CLASS_COLORS: Readonly<Record<SpectralClass, string>> = {
  O: "#9bb0ff",
  B: "#aabfff",
  A: "#cad7ff",
  F: "#f8f7ff",
  G: "#fff4e8",
  K: "#ffd2a1",
  M: "#ff9a55",
} as const;

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

/** Per-system live occupancy. Keyed by `systemId`; missing key = 0. */
export type OccupancyBySystem = Readonly<Record<string, number>>;

/** Optional callbacks the host can wire up. */
export interface StarChartCallbacks {
  /**
   * Fired when the user clicks the Warp button (or presses Enter
   * on it while focused). TASK-8 binds this to the warp flow.
   */
  onWarp?: (targetSystemId: string) => void;
  /**
   * Fired when the chart's open state flips. Useful for the host
   * to pause / resume the underlying canvas while the chart is
   * visible.
   */
  onOpenChange?: (open: boolean) => void;
}

/** Props for the star chart overlay. */
export interface StarChartProps {
  /** Whether the chart is open. The host (e.g. `App.tsx`) owns this. */
  open: boolean;
  /** Close handler — `Escape` key + close button both call this. */
  onClose: () => void;
  /** The full chart payload — sourced from `/api/galaxy/overview`. */
  overview: GalaxyOverview | null;
  /** Live occupancy (player counts per system). Polled separately. */
  occupancy: OccupancyBySystem;
  /**
   * Local player's current system id. Overrides the
   * `overview.currentSystemId` so the host can highlight
   * mid-warp "you are here" without re-fetching the overview.
   */
  currentSystemId?: string | null;
  /** Optional callbacks (warp + open state). */
  callbacks?: StarChartCallbacks;
  /**
   * Warp store. When provided, the chart subscribes and renders
   * the "Warping…" state on the source node. When omitted (unit
   * tests), the chart treats the warp as always idle.
   */
  warpStore?: WarpStore;
  /**
   * Bearer token for the polling endpoint. The chart itself is a
   * pure consumer of the `overview` + `occupancy` props, so the
   * token isn't read inside `StarChart`. The host
   * (`App.tsx`) uses it to fetch `/api/galaxy/overview` +
   * `/api/galaxy/health` and feed the results in. Kept in the
   * prop list so a future `chart-mounted` effect (e.g. an
   * auto-refresh on token rotation) has access to it without a
   * second `DriftClient` dependency.
   */
  authToken: string | null;
  /** Optional wall clock override (`Date.now`) — used by tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Format a warp-time label for the chart. Spec wording: "1m 20s"
 * for ≥60 s, "42s" for <60 s, "0s" for self-loops. The label is
 * also rendered (smaller) on each edge between two systems so the
 * player can read "5s" or "12s" at a glance.
 *
 * The polling interval for the live-occupancy overlay (5 s) lives
 * in the host (`App.tsx`) — the chart itself is a pure consumer
 * of the polled occupancy map.
 */
export function formatWarpTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds === 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds - minutes * 60);
  if (remaining === 0) return `${minutes}m`;
  return `${minutes}m ${remaining}s`;
}

/** Format a distance label: "1200 ls" — pure integer formatting. */
export function formatDistance(ls: number): string {
  if (!Number.isFinite(ls) || ls < 0) return "?";
  return `${Math.round(ls)} ls`;
}

/** Star marker radius — tuned for the 800x500 viewBox. */
const STAR_RADIUS = 6;
/** Selected / current star marker radius (slightly bigger for emphasis). */
const STAR_RADIUS_ACTIVE = 8;

/**
 * The chart overlay. See file header for design notes.
 */
export function StarChart({
  open,
  onClose,
  overview,
  occupancy,
  currentSystemId = null,
  callbacks,
  warpStore,
}: StarChartProps): React.JSX.Element | null {
  // -------------------------------------------------------------------
  // Local state
  // -------------------------------------------------------------------

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [warpStateKind, setWarpStateKind] = useState<string>("idle");

  // -------------------------------------------------------------------
  // Warp store subscription (optional)
  // -------------------------------------------------------------------

  useEffect(() => {
    if (!warpStore) return;
    const off = warpStore.subscribe((s) => setWarpStateKind(s.kind));
    return () => {
      off();
    };
  }, [warpStore]);

  // -------------------------------------------------------------------
  // Polling: occupancy every 5 s while open
  // -------------------------------------------------------------------

  // The occupancy is passed in from the parent (host polls
  // `/api/galaxy/health` and forwards the per-system counts).
  // When `open` flips to false we leave the parent's polling to
  // its own lifecycle — the parent can mirror this with the same
  // `useEffect` key (`open`).
  // No interval is started here so we don't double-poll.

  // -------------------------------------------------------------------
  // Selection helpers
  // -------------------------------------------------------------------

  const select = useCallback((id: string) => setSelectedId(id), []);

  // When the chart opens, clear any stale selection.
  useEffect(() => {
    if (!open) {
      setSelectedId(null);
    }
  }, [open]);

  // -------------------------------------------------------------------
  // Keyboard handlers (chart-level)
  // -------------------------------------------------------------------

  // We attach the `Escape` handler at the overlay level so the
  // chart closes no matter which child is focused. The node-level
  // `Enter`/`Space` handlers live on each node below.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  // Pre-compute the edge set so duplicate a→b / b→a entries from
  // the server's per-node neighbour lists collapse to a single
  // undirected line. The `neighbors` list on every node carries
  // both directions; we de-dupe by unordered pair so the SVG has
  // at most one `<line>` per pair.
  const undirectedEdges = useMemo(() => {
    if (!overview) return [];
    const seen = new Set<string>();
    const edges: { a: OverviewSystemNode; b: OverviewSystemNode; ls: number; seconds: number }[] =
      [];
    for (const sys of overview.systems) {
      for (const edge of sys.neighbors) {
        const a = sys.systemId;
        const b = edge.to;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const other = overview.systems.find((s) => s.systemId === b);
        if (!other) continue;
        edges.push({ a: sys, b: other, ls: edge.distanceLs, seconds: edge.warpTimeSeconds });
      }
    }
    return edges;
  }, [overview]);

  if (!open) return null;

  const viewW = overview?.viewBoxWidth ?? 800;
  const viewH = overview?.viewBoxHeight ?? 500;
  const systems = overview?.systems ?? [];
  const highlightedCurrent = currentSystemId ?? overview?.currentSystemId ?? null;

  // Selected node (with its shortest-edge warp time for the Warp button).
  const selectedNode = selectedId ? (systems.find((s) => s.systemId === selectedId) ?? null) : null;
  const selectedNeighbor =
    selectedNode && selectedNode.neighbors.length > 0 ? selectedNode.neighbors[0]! : null;
  const warpDisabled =
    !selectedNode || warpStateKind !== "idle" || selectedNode.systemId === highlightedCurrent;

  return (
    <div
      data-testid="drift-star-chart"
      role="dialog"
      aria-modal="true"
      aria-label="Star chart"
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(2, 4, 10, 0.94)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1500,
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <div
        data-testid="drift-star-chart-header"
        style={{
          width: "100%",
          maxWidth: 900,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.24em",
              textTransform: "uppercase",
              color: "#8b949e",
            }}
          >
            Star Chart
          </div>
          <div
            data-testid="drift-star-chart-title"
            style={{
              fontSize: 16,
              letterSpacing: "0.12em",
              marginTop: 4,
            }}
          >
            {overview ? `${systems.length} systems · seed ${overview.galaxySeed}` : "Loading…"}
          </div>
        </div>
        <button
          data-testid="drift-star-chart-close"
          type="button"
          aria-label="Close star chart"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "1px solid rgba(255, 255, 255, 0.2)",
            color: "#e6edf3",
            borderRadius: 4,
            padding: "6px 12px",
            cursor: "pointer",
            fontSize: 11,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontFamily: "inherit",
          }}
        >
          Close (Esc)
        </button>
      </div>

      <svg
        data-testid="drift-star-chart-svg"
        viewBox={`0 0 ${viewW} ${viewH}`}
        role="img"
        aria-label="Galaxy map"
        style={{
          width: "100%",
          maxWidth: 900,
          height: "auto",
          aspectRatio: `${viewW} / ${viewH}`,
          background: "rgba(255, 255, 255, 0.02)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: 6,
        }}
      >
        {/* Edges */}
        <g
          data-testid="drift-star-chart-edges"
          stroke="rgba(180, 200, 220, 0.25)"
          strokeWidth={0.6}
        >
          {undirectedEdges.map((edge) => {
            const x1 = edge.a.pos2D.x;
            const y1 = edge.a.pos2D.y;
            const x2 = edge.b.pos2D.x;
            const y2 = edge.b.pos2D.y;
            return (
              <line key={`${edge.a.systemId}-${edge.b.systemId}`} x1={x1} y1={y1} x2={x2} y2={y2} />
            );
          })}
        </g>

        {/* Nodes */}
        <g data-testid="drift-star-chart-nodes">
          {systems.map((sys) => {
            const isSelected = sys.systemId === selectedId;
            const isCurrent = sys.systemId === highlightedCurrent;
            const isWarpingFrom = warpStore ? warpTargetIsInFlight(warpStore, sys.systemId) : false;
            const players = occupancy[sys.systemId] ?? 0;
            const color = STAR_CLASS_COLORS[sys.starClass];
            const radius = isSelected || isCurrent ? STAR_RADIUS_ACTIVE : STAR_RADIUS;
            return (
              <g
                key={sys.systemId}
                data-testid="drift-star-chart-node"
                data-system-id={sys.systemId}
                data-system-name={sys.name}
                data-star-class={sys.starClass}
                data-is-current={isCurrent ? "true" : "false"}
                data-is-selected={isSelected ? "true" : "false"}
                data-occupancy={String(players)}
                data-warping={isWarpingFrom ? "true" : "false"}
                role="button"
                tabIndex={0}
                aria-label={`${sys.name}, ${players} players, ${sys.starClass} class`}
                onClick={() => select(sys.systemId)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    select(sys.systemId);
                  }
                }}
                style={{
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                {/* Halo for the selected / current system. */}
                {(isSelected || isCurrent) && (
                  <circle
                    cx={sys.pos2D.x}
                    cy={sys.pos2D.y}
                    r={radius + 6}
                    fill="none"
                    stroke={isCurrent ? "rgba(46, 160, 67, 0.85)" : "rgba(255, 255, 255, 0.5)"}
                    strokeWidth={1.4}
                  />
                )}
                {/* Star marker. */}
                <circle
                  cx={sys.pos2D.x}
                  cy={sys.pos2D.y}
                  r={radius}
                  fill={color}
                  stroke={isCurrent ? "#2ea043" : isSelected ? "#ffffff" : "rgba(0,0,0,0.6)"}
                  strokeWidth={isCurrent || isSelected ? 1.4 : 0.6}
                >
                  {isWarpingFrom && (
                    <animate
                      attributeName="opacity"
                      values="1;0.4;1"
                      dur="1.2s"
                      repeatCount="indefinite"
                    />
                  )}
                </circle>
                {/* Label */}
                <text
                  x={sys.pos2D.x + radius + 4}
                  y={sys.pos2D.y + 4}
                  fill="#e6edf3"
                  fontSize={11}
                  fontFamily="ui-monospace, monospace"
                  style={{ pointerEvents: "none" }}
                >
                  {sys.name}
                </text>
                {/* Occupancy badge (only when ≥1). */}
                {players > 0 && (
                  <g pointerEvents="none">
                    <rect
                      x={sys.pos2D.x + radius + 4}
                      y={sys.pos2D.y + 16}
                      width={28}
                      height={14}
                      rx={3}
                      fill="rgba(46, 160, 67, 0.92)"
                    />
                    <text
                      x={sys.pos2D.x + radius + 8}
                      y={sys.pos2D.y + 26}
                      fill="#ffffff"
                      fontSize={10}
                      fontFamily="ui-monospace, monospace"
                      fontWeight={600}
                    >
                      {players}P
                    </text>
                  </g>
                )}
                {/* Warping badge — replaces occupancy when warping. */}
                {isWarpingFrom && (
                  <g pointerEvents="none">
                    <rect
                      x={sys.pos2D.x + radius + 4}
                      y={sys.pos2D.y + 16}
                      width={56}
                      height={14}
                      rx={3}
                      fill="rgba(248, 81, 73, 0.92)"
                    />
                    <text
                      x={sys.pos2D.x + radius + 8}
                      y={sys.pos2D.y + 26}
                      fill="#ffffff"
                      fontSize={10}
                      fontFamily="ui-monospace, monospace"
                      fontWeight={600}
                    >
                      Warping…
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>

        {/* Edge labels for the 12 closest — readability on top of the dense web. */}
        <g
          data-testid="drift-star-chart-edge-labels"
          fill="rgba(180, 200, 220, 0.55)"
          fontSize={9}
          fontFamily="ui-monospace, monospace"
        >
          {undirectedEdges
            .slice()
            .sort((a, b) => a.seconds - b.seconds)
            .slice(0, 12)
            .map((edge) => {
              const mx = (edge.a.pos2D.x + edge.b.pos2D.x) / 2;
              const my = (edge.a.pos2D.y + edge.b.pos2D.y) / 2;
              return (
                <text
                  key={`label-${edge.a.systemId}-${edge.b.systemId}`}
                  x={mx}
                  y={my}
                  textAnchor="middle"
                  style={{ pointerEvents: "none" }}
                >
                  {formatDistance(edge.ls)} · {formatWarpTime(edge.seconds)}
                </text>
              );
            })}
        </g>
      </svg>

      {/* Bottom panel: selected info + Warp button */}
      <div
        data-testid="drift-star-chart-panel"
        style={{
          width: "100%",
          maxWidth: 900,
          marginTop: 16,
          padding: "12px 16px",
          background: "rgba(0, 0, 0, 0.55)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: 6,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {selectedNode ? (
            <>
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: "#8b949e",
                }}
              >
                Selected
              </div>
              <div
                data-testid="drift-star-chart-selected-name"
                style={{ fontSize: 14, fontWeight: 600 }}
              >
                {selectedNode.name}
              </div>
              {selectedNeighbor && (
                <div
                  data-testid="drift-star-chart-warp-time"
                  style={{ fontSize: 11, color: "#9aa3ad" }}
                >
                  Shortest hop: {formatDistance(selectedNeighbor.distanceLs)} · warp{" "}
                  {formatWarpTime(selectedNeighbor.warpTimeSeconds)}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12, color: "#8b949e", fontStyle: "italic" }}>
              Click a system to select it. Tab + Enter also works.
            </div>
          )}
        </div>
        <button
          type="button"
          data-testid="drift-star-chart-warp"
          aria-label={
            selectedNode
              ? `Warp to ${selectedNode.name}${selectedNeighbor ? `, ${formatWarpTime(selectedNeighbor.warpTimeSeconds)}` : ""}`
              : "Warp"
          }
          disabled={warpDisabled}
          onClick={() => {
            if (!selectedNode || warpDisabled) return;
            callbacks?.onWarp?.(selectedNode.systemId);
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              if (!selectedNode || warpDisabled) return;
              callbacks?.onWarp?.(selectedNode.systemId);
            }
          }}
          style={{
            padding: "10px 18px",
            background: warpDisabled ? "rgba(255,255,255,0.06)" : "#1f6feb",
            color: warpDisabled ? "#8b949e" : "#ffffff",
            border: "none",
            borderRadius: 4,
            cursor: warpDisabled ? "not-allowed" : "pointer",
            fontFamily: "inherit",
            fontSize: 12,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontWeight: 600,
            minWidth: 110,
          }}
        >
          {warpStateKind !== "idle"
            ? "Warping…"
            : selectedNode
              ? `Warp ${formatWarpTime(selectedNeighbor?.warpTimeSeconds ?? 0)}`
              : "Warp"}
        </button>
      </div>
    </div>
  );
}

/**
 * Convenience helper: is the warp machine currently heading
 * *from* `systemId`? Used to render the "Warping…" badge on the
 * source node (TASK-8 will use this same hook when wiring the
 * real flow).
 */
function warpTargetIsInFlight(store: WarpStore, systemId: string): boolean {
  const s = store.current;
  return isWarpInFlight(s) && s.targetSystemId === systemId;
}
