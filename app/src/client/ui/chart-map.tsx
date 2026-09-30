import React from 'react';
import { CHART_VIEWBOX } from '@shared/galaxy/chart';
import type { ChartSystem } from '@shared/galaxy/chart';
import type { SpectralClass } from '@shared/galaxy/types';

/** Spectral-class node colors (hottest→coolest, standard star palette). */
export const SPECTRAL_COLORS: Record<SpectralClass, string> = {
  O: '#9bb0ff',
  B: '#aabfff',
  A: '#cad7ff',
  F: '#f8f7ff',
  G: '#fff4ea',
  K: '#ffd2a1',
  M: '#ffcc6f',
};

export const CURRENT_NODE_STROKE = '#38bdf8';
export const SELECTED_NODE_STROKE = '#f8fafc';
export const FOCUS_RING_COLOR = '#7dd3fc';
export const WARPING_TEXT = 'Warping…';

/**
 * Pure presentational star chart (TASK-7). No fetching, no state of its own —
 * everything arrives as props, so the SVG structure is a pure function of
 * the seeded chart data (that is what the snapshot test freezes).
 *
 * Keyboard: each node is a focusable role="button" (Tab order = chart
 * order); Enter/Space activates it. Escape is handled by the container.
 */
export interface ChartMapProps {
  systems: ChartSystem[];
  /** Live occupancy per systemId (from /api/galaxy/health); 0 → no badge. */
  occupancy: Record<string, number>;
  currentSystemId: string | null;
  selectedSystemId: string | null;
  /** Node showing 'Warping…' during a transition (the source system). */
  warpingSystemId: string | null;
  /** Focused node (for a visible focus ring, TASK-54 builds on this). */
  focusedSystemId: string | null;
  /** Search filter; non-matching nodes are dimmed, never removed. */
  query: string;
  onNodeActivate?: (systemId: string) => void;
  onNodeFocusChange?: (systemId: string | null) => void;
}

function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || name.toLowerCase().includes(q);
}

function Edge({ system, other }: { system: ChartSystem; other: ChartSystem }) {
  // Draw each undirected edge exactly once (pair order = deterministic).
  if (system.systemId >= other.systemId) return null;
  const n = system.neighbors.find((x) => x.to === other.systemId);
  if (!n) return null;
  const mx = (system.pos2D.x + other.pos2D.x) / 2;
  const my = (system.pos2D.y + other.pos2D.y) / 2;
  return (
    <g data-testid="star-chart-edge" data-from={system.systemId} data-to={other.systemId}>
      <line
        x1={system.pos2D.x}
        y1={system.pos2D.y}
        x2={other.pos2D.x}
        y2={other.pos2D.y}
        stroke="#3b4a63"
        strokeWidth={1.5}
        strokeDasharray="6 4"
      />
      {/* Label sits on a dark pill so it stays readable over the starfield. */}
      <rect
        x={mx - 52}
        y={my - 9}
        width={104}
        height={16}
        rx={4}
        fill="rgba(11, 14, 20, 0.85)"
        stroke="#2a3346"
        strokeWidth={0.5}
      />
      <text
        x={mx}
        y={my + 3}
        textAnchor="middle"
        fontSize={10}
        fill="#8b97ab"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        {`${n.distanceLabel} · ${n.warpTimeLabel}`}
      </text>
    </g>
  );
}

function Node({
  system,
  occupancy,
  isCurrent,
  isSelected,
  isWarping,
  isFocused,
  dimmed,
  onActivate,
  onFocusChange,
}: {
  system: ChartSystem;
  occupancy: number;
  isCurrent: boolean;
  isSelected: boolean;
  isWarping: boolean;
  isFocused: boolean;
  dimmed: boolean;
  onActivate?: (systemId: string) => void;
  onFocusChange?: (systemId: string | null) => void;
}) {
  const { x, y } = system.pos2D;
  const stroke = isCurrent ? CURRENT_NODE_STROKE : isSelected ? SELECTED_NODE_STROKE : '#2a3346';
  const strokeWidth = isCurrent || isSelected ? 3 : 1;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate?.(system.systemId);
    }
  };
  const label = `${system.name} (${system.starClass} star)${
    isCurrent ? ', current system' : ''
  }${occupancy > 0 ? `, ${occupancy} player${occupancy === 1 ? '' : 's'}` : ''}`;
  return (
    <g
      data-testid="star-chart-node"
      data-system-id={system.systemId}
      data-current={isCurrent}
      data-selected={isSelected}
      className="star-chart-node"
      opacity={dimmed ? 0.25 : 1}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={isSelected}
      onClick={() => onActivate?.(system.systemId)}
      onKeyDown={onKeyDown}
      onFocus={() => onFocusChange?.(system.systemId)}
      onBlur={() => onFocusChange?.(null)}
      style={{ cursor: 'pointer', outline: 'none' }}
    >
      {isFocused && (
        <circle cx={x} cy={y} r={16} fill="none" stroke={FOCUS_RING_COLOR} strokeWidth={2} />
      )}
      <circle
        cx={x}
        cy={y}
        r={10}
        fill={SPECTRAL_COLORS[system.starClass]}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      <text
        x={x}
        y={y + 26}
        textAnchor="middle"
        fontSize={12}
        fill="#d6deeb"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        {system.name}
      </text>
      {isWarping && (
        <text
          data-testid="star-chart-warping"
          x={x}
          y={y - 18}
          textAnchor="middle"
          fontSize={11}
          fill="#fbbf24"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          {WARPING_TEXT}
        </text>
      )}
      {occupancy > 0 && (
        <g data-testid="occupancy-badge">
          <circle cx={x + 12} cy={y - 12} r={8} fill="#16a34a" stroke="#0b0e14" strokeWidth={1} />
          <text
            x={x + 12}
            y={y - 8.5}
            textAnchor="middle"
            fontSize={10}
            fill="#ffffff"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            {occupancy}
          </text>
        </g>
      )}
    </g>
  );
}

export function ChartMap({
  systems,
  occupancy,
  currentSystemId,
  selectedSystemId,
  warpingSystemId,
  focusedSystemId,
  query,
  onNodeActivate,
  onNodeFocusChange,
}: ChartMapProps): React.ReactElement {
  return (
    <svg
      id="star-chart-map"
      viewBox={`0 0 ${CHART_VIEWBOX.width} ${CHART_VIEWBOX.height}`}
      width="100%"
      role="group"
      aria-label="Star chart map"
      style={{ display: 'block' }}
    >
      {systems.map((s) =>
        systems.map((t) => <Edge key={`edge-${s.systemId}-${t.systemId}`} system={s} other={t} />),
      )}
      {systems.map((s) => (
        <Node
          key={s.systemId}
          system={s}
          occupancy={occupancy[s.systemId] ?? 0}
          isCurrent={s.systemId === currentSystemId}
          isSelected={s.systemId === selectedSystemId}
          isWarping={s.systemId === warpingSystemId}
          isFocused={s.systemId === focusedSystemId}
          dimmed={!matchesQuery(s.name, query)}
          onActivate={onNodeActivate}
          onFocusChange={onNodeFocusChange}
        />
      ))}
    </svg>
  );
}
