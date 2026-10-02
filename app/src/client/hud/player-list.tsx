import React from 'react';
import type { PresenceStore } from '@client/net/presence';

/**
 * TASK-15: in-system player list (bottom-left, compact monospace).
 * Re-renders ONLY on presence events: PresenceStore never emits on the
 * 10 Hz entity cadence, so this component stays quiet while flying.
 * TASK-36: each row's icon switches with the player's regime — a walking
 * figure (amber) on foot vs a ship (green) in the cockpit; the flag is
 * derived from the entity list and flips live on disembark / re-enter.
 * The local callsign renders first with a "(you)" marker.
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
          <RegimeIcon
            mode={row.onFoot ? 'foot' : 'ship'}
            color={row.onFoot ? ICON_AMBER : ICON_GREEN}
          />
          <span style={{ color: row.you ? '#d6deeb' : '#a8b3c5' }}>{row.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The per-row regime icon (TASK-36): a walking figure on foot vs a ship in
 * the cockpit — inline SVG (crisp at 10 px, no emoji-font surprises in
 * headless e2e). `data-mode` makes the state assertable in tests.
 */
function RegimeIcon({ mode, color }: { mode: 'foot' | 'ship'; color: string }) {
  return mode === 'foot' ? (
    <span aria-hidden data-mode="foot" style={styles.icon}>
      <svg viewBox="0 0 16 16" width="10" height="10" role="img" aria-label="on foot">
        <circle cx="9.6" cy="2.9" r="1.7" fill={color} />
        <path
          d="M9 5.2 L6.4 8.8 L4.1 13 M6.4 8.8 L9.3 13 M9 5.8 L11.9 7.8 L12.7 10.8"
          stroke={color}
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </span>
  ) : (
    <span aria-hidden data-mode="ship" style={styles.icon}>
      <svg viewBox="0 0 16 16" width="10" height="10" role="img" aria-label="in ship">
        <path d="M8 1.2 L13.2 13 L8 10.2 L2.8 13 Z" fill={color} />
      </svg>
    </span>
  );
}

const ICON_GREEN = '#4ade80';
const ICON_AMBER = '#fbbf24';

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
  icon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 12,
    height: 12,
    flexShrink: 0,
  },
};
