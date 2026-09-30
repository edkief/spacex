import React from 'react';
import { frameMonitor, type FrameStats } from '@client/perf/frameMonitor';

/**
 * TASK-57: the dev-mode frame monitor overlay. `DebugOverlay` is a pure
 * presentational panel (top-right, monospace) rendering one stats snapshot;
 * `FrameMonitorOverlay` is the host that owns the F3 keybind and polls
 * `frameMonitor.getFrameStats()` at 2 Hz — never per-frame, so toggling it
 * cannot measurably move p95 frame time.
 *
 * Mounted in main.tsx only when `import.meta.env.DEV` — prod builds never
 * ship it.
 */

export interface DebugOverlayProps {
  stats: FrameStats;
  /** Present when the host wires the stats export (JSON download). */
  onExport?: () => void;
}

export function DebugOverlay({ stats, onExport }: DebugOverlayProps) {
  return (
    <div id="frame-monitor" data-testid="frame-monitor" style={styles.panel} aria-hidden={true}>
      <div style={styles.title}>FRAME MONITOR (F3)</div>
      <div style={styles.row}>
        FPS <span style={styles.value}>{stats.fps.toFixed(0)}</span>
      </div>
      <div style={styles.row}>
        FRAME p50/p95/p99{' '}
        <span style={styles.value}>
          {stats.frameTimeP50Ms.toFixed(2)} / {stats.frameTimeP95Ms.toFixed(2)} /{' '}
          {stats.frameTimeP99Ms.toFixed(2)} ms
        </span>
      </div>
      <div style={styles.row}>
        DRAWS <span style={styles.value}>{stats.drawCalls}</span> · TRIS{' '}
        <span style={styles.value}>{stats.triangles}</span>
      </div>
      <div style={styles.row}>
        ENTITIES <span style={styles.value}>{stats.entities}</span>
      </div>
      {onExport && (
        <button id="frame-monitor-export" type="button" onClick={onExport} style={styles.button}>
          EXPORT STATS
        </button>
      )}
    </div>
  );
}

/** Poll cadence: 2 Hz — the spec's "no per-frame re-render" bound. */
export const OVERLAY_POLL_MS = 500;

/** Build the stats export payload (flat, timestamped, JSON-serializable). */
export function statsExportPayload(stats: FrameStats, exportedAt = new Date().toISOString()) {
  return { exportedAt, ...stats };
}

/** Download the current stats as a JSON file (the overlay's export button). */
export function downloadStats(stats: FrameStats): void {
  const payload = JSON.stringify(statsExportPayload(stats), null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `drift-frame-stats-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FrameMonitorOverlay() {
  const [visible, setVisible] = React.useState(false);
  const [stats, setStats] = React.useState<FrameStats | null>(null);

  // F3 toggles the overlay; typing in an input (chat) never does.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'F3') {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Poll at 2 Hz only while visible — hidden costs nothing.
  React.useEffect(() => {
    if (!visible) return;
    setStats(frameMonitor.getFrameStats());
    const id = window.setInterval(() => setStats(frameMonitor.getFrameStats()), OVERLAY_POLL_MS);
    return () => window.clearInterval(id);
  }, [visible]);

  if (!visible || !stats) return null;
  return <DebugOverlay stats={stats} onExport={() => downloadStats(stats)} />;
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    top: '1rem',
    right: '1rem',
    zIndex: 60,
    padding: '0.6rem 0.8rem',
    background: 'rgba(11, 14, 20, 0.85)',
    border: '1px solid #2a3346',
    borderRadius: 8,
    color: '#d6deeb',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.7rem',
    lineHeight: 1.5,
    pointerEvents: 'auto',
  },
  title: { color: '#67e8f9', letterSpacing: '0.1em', marginBottom: '0.25rem' },
  row: { whiteSpace: 'pre' },
  value: { color: '#a5f3fc' },
  button: {
    marginTop: '0.4rem',
    background: '#1d2739',
    border: '1px solid #2a3346',
    borderRadius: 4,
    color: '#d6deeb',
    padding: '0.2rem 0.5rem',
    fontFamily: 'inherit',
    fontSize: '0.65rem',
    letterSpacing: '0.08em',
    cursor: 'pointer',
  },
};
