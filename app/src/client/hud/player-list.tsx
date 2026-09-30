import React from 'react';
import type { PresenceStore } from '@client/net/presence';

/**
 * TASK-15: in-system player list (bottom-left, compact monospace).
 * Re-renders ONLY on presence events: PresenceStore never emits on the
 * 10 Hz entity cadence, so this component stays quiet while flying.
 * Each remote callsign gets a status dot (green = in-ship, amber =
 * on-foot — the flag arrives with TASK-36); the local callsign renders
 * first with a "(you)" marker.
 */
export function PlayerList({ store }: { store: PresenceStore }) {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => store.subscribe(bump), [store]);

  const self = store.selfPlayer;
  const others = store.otherPlayers;
  if (!self) return null;

  const rows: Array<{ key: string; label: string; onFoot?: boolean; you?: boolean }> = [
    { key: self.playerId, label: `${self.callsign} (you)`, onFoot: self.onFoot, you: true },
    ...others.map((p) => ({ key: p.playerId, label: p.callsign, onFoot: p.onFoot })),
  ];

  return (
    <div id="player-list" style={styles.box} data-occupancy={store.occupancy}>
      {rows.map((row) => (
        <div key={row.key} style={styles.row}>
          <span
            aria-hidden
            style={{
              ...styles.dot,
              background: row.onFoot ? DOT_AMBER : DOT_GREEN,
              boxShadow: row.you ? `0 0 4px ${DOT_GREEN}` : undefined,
            }}
          />
          <span style={{ color: row.you ? '#d6deeb' : '#a8b3c5' }}>{row.label}</span>
        </div>
      ))}
    </div>
  );
}

const DOT_GREEN = '#4ade80';
const DOT_AMBER = '#fbbf24';

const styles: Record<string, React.CSSProperties> = {
  box: {
    position: 'absolute',
    left: '1rem',
    bottom: '1rem',
    padding: '0.5rem 0.75rem',
    border: '1px solid #2a3346',
    borderRadius: 8,
    background: 'rgba(17, 21, 31, 0.85)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.8rem',
    lineHeight: 1.5,
    userSelect: 'none',
  },
  row: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
  },
};
