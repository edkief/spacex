import React from 'react';
import type { ChartSystem } from '@shared/galaxy/chart';
import type { GalaxyShardHealth } from '@shared/health';
import { dispatchWarpEvent, warpSubscribe, lastWarpEvent } from '@client/state/warp';
import { ChartMap } from './chart-map';

/** Poll cadence for the live occupancy badges (TASK-7 spec: every 5 s). */
const OCCUPANCY_POLL_MS = 5000;

/**
 * Star chart panel (TASK-7): the navigation surface for inter-system travel.
 *
 * - Overview data comes from GET /api/galaxy/overview (seeded, cached
 *   server-side): one node per system (star-class color) + edges labeled
 *   with light-second distances and warp times.
 * - Occupancy badges poll GET /api/galaxy/health every 5 s while the panel
 *   is mounted (unmount on close stops the polling).
 * - Selection: click or Enter on a node; the Warp button then shows the
 *   estimated travel time. Warp click dispatches 'warp-started' on the
 *   shared warp bus (TASK-8 implements the flow); the panel stays open and
 *   shows 'Warping…' on the source node until 'warp-complete'.
 * - Keyboard: Tab reaches the nodes, Enter selects, Escape closes.
 */
export interface StarChartProps {
  /** Session bearer token for the authenticated galaxy endpoints. */
  token: string;
  /** The system the player is in right now (highlighted node; the chart's home). */
  currentSystemId: string;
  onClose: () => void;
}

interface OverviewPayload {
  seed: string;
  systems: ChartSystem[];
}

async function authFetch(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

export function StarChart({ token, currentSystemId, onClose }: StarChartProps): React.ReactElement {
  const [systems, setSystems] = React.useState<ChartSystem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [occupancy, setOccupancy] = React.useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [warpingId, setWarpingId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');

  // Overview: one fetch per (home, current system) — the server caches it.
  const currentRef = React.useRef(currentSystemId);
  currentRef.current = currentSystemId;
  React.useEffect(() => {
    let cancelled = false;
    setSystems(null);
    setError(null);
    authFetch(`/api/galaxy/overview?home=${currentRef.current}`, token)
      .then(async (res) => {
        if (!res.ok) throw new Error(`overview ${res.status}`);
        const body = (await res.json()) as OverviewPayload;
        if (!cancelled) setSystems(body.systems);
      })
      .catch(() => {
        if (!cancelled) setError('star chart unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [token, currentSystemId]);

  // Live occupancy: fetch now, then every 5 s while the panel is open.
  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await authFetch('/api/galaxy/health', token);
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { shards: GalaxyShardHealth[] };
        const next: Record<string, number> = {};
        for (const shard of body.shards) next[shard.systemId] = shard.players;
        if (!cancelled) setOccupancy(next);
      } catch {
        // transient: keep the last known badges
      }
    };
    void poll();
    const timer = setInterval(poll, OCCUPANCY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  // Warp bus: the chart mirrors the shared warp state (TASK-8 dispatches).
  React.useEffect(() => {
    const apply = (e: ReturnType<typeof lastWarpEvent>) => {
      if (!e) return;
      if (e.type === 'warp-started') setWarpingId(e.fromSystemId);
      else setWarpingId(null);
    };
    apply(lastWarpEvent());
    return warpSubscribe(apply);
  }, []);

  // Escape closes the chart (the panel is the top-most UI while open).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selected = systems?.find((s) => s.systemId === selectedId) ?? null;
  const neighbor = selected?.neighbors.find((n) => n.to === currentSystemId);

  const activate = (systemId: string): void => {
    if (systemId === currentSystemId) return;
    setSelectedId(systemId === selectedId ? null : systemId);
  };

  const warp = (): void => {
    if (!selected || !neighbor) return;
    dispatchWarpEvent({
      type: 'warp-started',
      fromSystemId: currentSystemId,
      toSystemId: selected.systemId,
      etaSeconds: neighbor.warpTimeSeconds,
    });
  };

  return (
    <div id="star-chart" role="dialog" aria-label="Star chart" style={styles.panel}>
      <style>{`#star-chart .star-chart-node:focus { outline: none; }`}</style>
      <div style={styles.header}>
        <h2 style={styles.title}>STAR CHART</h2>
        <input
          id="star-chart-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search systems…"
          aria-label="Search systems"
          style={styles.search}
        />
        <button id="star-chart-close" type="button" onClick={onClose} style={styles.closeButton}>
          CLOSE (ESC)
        </button>
      </div>
      {systems === null && !error && (
        <p id="star-chart-loading" style={styles.mono}>
          LOADING…
        </p>
      )}
      {error && (
        <p id="star-chart-error" role="alert" style={styles.error}>
          {error}
        </p>
      )}
      {systems !== null && (
        <ChartMap
          systems={systems}
          occupancy={occupancy}
          currentSystemId={currentSystemId}
          selectedSystemId={selectedId}
          warpingSystemId={warpingId}
          focusedSystemId={focusedId}
          query={query}
          onNodeActivate={activate}
          onNodeFocusChange={setFocusedId}
        />
      )}
      <div style={styles.footer}>
        <span style={styles.hint}>
          {selected && neighbor
            ? `→ ${selected.name} · ${neighbor.distanceLabel} · ${neighbor.warpTimeLabel}`
            : 'Select a system to plot a warp'}
        </span>
        <button
          id="warp-button"
          type="button"
          // TASK-8: double-warp guard — disabled for the whole transition
          // (warp-started until warp-complete/warp-failed clear it).
          disabled={!selected || !neighbor || warpingId !== null}
          onClick={warp}
          style={{ ...styles.warpButton, opacity: selected && neighbor && !warpingId ? 1 : 0.4 }}
        >
          {warpingId ? 'WARPING…' : neighbor ? `WARP — ${neighbor.warpTimeLabel}` : 'WARP'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 'min(92vw, 900px)',
    padding: '1rem 1.25rem',
    border: '1px solid #2a3346',
    borderRadius: 12,
    background: 'rgba(13, 17, 26, 0.96)',
    zIndex: 90,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#d6deeb',
  },
  header: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' },
  title: { margin: 0, fontSize: '1rem', letterSpacing: '0.12em', flexShrink: 0 },
  search: {
    flex: 1,
    background: '#0b0e14',
    border: '1px solid #2a3346',
    borderRadius: 6,
    color: '#d6deeb',
    padding: '0.35rem 0.6rem',
    fontFamily: 'inherit',
    fontSize: '0.8rem',
  },
  closeButton: {
    background: '#1d2739',
    border: '1px solid #2a3346',
    borderRadius: 6,
    color: '#d6deeb',
    padding: '0.35rem 0.7rem',
    fontFamily: 'inherit',
    fontSize: '0.7rem',
    letterSpacing: '0.08em',
    cursor: 'pointer',
  },
  mono: { color: '#8b97ab', fontSize: '0.8rem' },
  error: { color: '#f87171', fontSize: '0.8rem' },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  hint: { color: '#8b97ab', fontSize: '0.75rem' },
  warpButton: {
    background: '#134e4a',
    border: '1px solid #16a34a',
    borderRadius: 6,
    color: '#d6deeb',
    padding: '0.45rem 1.1rem',
    fontFamily: 'inherit',
    fontSize: '0.8rem',
    letterSpacing: '0.08em',
    cursor: 'pointer',
  },
};
