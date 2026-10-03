import React from 'react';
import {
  KILL_FEED_TTL_MS,
  killFeedSubscribe,
  removeKillFeedEntry,
  type KillFeedEntry,
} from '@client/state/kill-feed';

/**
 * TASK-47: the persistent kill feed (top-center, last 5, 10 s fade). Each
 * line is 'killer ▸ weapon ▸ victim' in resolved callsigns; player-vs-player
 * kills render white, player-vs-AI grey (entry.pvp). The feed is fed ONLY by
 * the store (kill combat_events) — never the snapshot cadence. One TTL timer
 * per entry id drives removeKillFeedEntry; all timers clear on unmount.
 */
export function KillFeed() {
  const [items, setItems] = React.useState<KillFeedEntry[]>([]);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  React.useEffect(
    () =>
      killFeedSubscribe((entries) => {
        setItems(entries);
        // Schedule the TTL drop once per NEW entry id (a re-render of the
        // same batch must not reset the clock).
        for (const entry of entries) {
          if (!timers.current.has(entry.id)) {
            timers.current.set(
              entry.id,
              setTimeout(() => removeKillFeedEntry(entry.id), KILL_FEED_TTL_MS),
            );
          }
        }
        // Entries already gone (TTL pruned at a later push, cap of 5) lose
        // their timers.
        for (const [id, timer] of timers.current) {
          if (!entries.some((e) => e.id === id)) {
            clearTimeout(timer);
            timers.current.delete(id);
          }
        }
      }),
    [],
  );

  React.useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  return (
    <div id="kill-feed" style={styles.feed} aria-live="polite">
      <style>{keyframes}</style>
      {items.map((entry) => (
        <div key={entry.id} style={{ ...styles.entry, color: entry.pvp ? '#ffffff' : '#8b97ab' }}>
          {`${entry.killer} ▸ ${entry.weapon} ▸ ${entry.victim}`}
        </div>
      ))}
    </div>
  );
}

/** Hold solid for the first 8 s, fade out over the last 2 s of the TTL. */
const keyframes = `
@keyframes kill-feed-life {
  0%   { opacity: 0; }
  5%   { opacity: 1; }
  80%  { opacity: 1; }
  100% { opacity: 0; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  feed: {
    position: 'absolute',
    top: '1rem',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.25rem',
    pointerEvents: 'none',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.8rem',
    userSelect: 'none',
    zIndex: 85, // above canvas (0) + reentry tint (80); below the star chart (90)
  },
  entry: {
    padding: '0.2rem 0.6rem',
    borderRadius: 6,
    background: 'rgba(17, 21, 31, 0.7)',
    animation: `kill-feed-life ${KILL_FEED_TTL_MS}ms ease-in-out forwards`,
  },
};
