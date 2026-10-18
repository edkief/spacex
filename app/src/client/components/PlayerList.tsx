/**
 * PlayerList — TASK-15 in-system roster HUD.
 *
 * Bottom-left HUD widget that renders every player currently in
 * the local player's system. Each row is the callsign plus a
 * small status dot that reflects the player's activity (in-ship
 * vs on-foot). The local player's row is flagged with "(you)" so
 * the player knows which ship is theirs.
 *
 * Implementation:
 *   - `useSyncExternalStore` subscribes to the `PresenceStore` and
 *     re-renders only when the roster changes — the server only
 *     pushes `presence` frames when the roster actually changes, so
 *     the HUD never re-renders during steady state.
 *   - Monospace font + a thin border so the column reads as a
 *     "ship log" rather than a UI panel. Cheap to render: at most
 *     16 rows (the shard cap).
 *
 * @see ../net/presence.ts for the store API + event shapes.
 * @see ./ToastStack.tsx for the sibling join/leave toast component.
 */

import { useSyncExternalStore } from "react";
import type * as React from "react";

import {
  type PresenceStore,
  type PresencePlayer,
  statusDotColor,
  statusIcon,
} from "../net/presence.js";

/** Props for the player list. */
export interface PlayerListProps {
  /** The presence store to subscribe to. Required. */
  store: PresenceStore;
}

/**
 * Selector wrapper so `useSyncExternalStore` can return the roster
 * by stable reference. The store's `snapshot()` keeps a cached
 * reference so a no-op re-render can short-circuit; we expose it
 * here so React's internal `Object.is` check returns `true` between
 * updates.
 */
function getPlayersSnapshot(store: PresenceStore): PresencePlayer[] {
  return store.snapshot();
}

/**
 * Bottom-left roster HUD. See file header for design notes.
 */
export function PlayerList({ store }: PlayerListProps): React.JSX.Element {
  // Selector returns the canonical roster snapshot. We depend on the
  // store's own reference-identity guarantee: `snapshot()` returns a
  // new array only when called from `applyPresenceFrame()` /
  // `leaveAll()`, so React skips renders in steady state.
  const players = useSyncExternalStore(
    (onStoreChange) => store.subscribe(() => onStoreChange()),
    () => getPlayersSnapshot(store),
    () => getPlayersSnapshot(store),
  );

  return (
    <div
      data-testid="drift-player-list"
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        padding: "10px 12px",
        background: "rgba(0, 0, 0, 0.55)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: 6,
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
        fontSize: 12,
        color: "#e6edf3",
        letterSpacing: "0.04em",
        minWidth: 180,
        pointerEvents: "none",
        zIndex: 1000,
      }}
    >
      <div
        data-testid="drift-player-list-header"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.18em",
          fontSize: 10,
          color: "#8b949e",
          marginBottom: 6,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>In System</span>
        <span data-testid="drift-player-list-count">{players.length}</span>
      </div>
      {players.length === 0 ? (
        <div
          data-testid="drift-player-list-empty"
          style={{ color: "#8b949e", fontStyle: "italic", padding: "2px 0" }}
        >
          (alone)
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {players.map((p) => (
            <li
              key={p.playerId}
              data-testid="drift-player-list-row"
              data-callsign={p.callsign}
              data-is-you={p.isYou ? "true" : "false"}
              data-state={p.state}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "1px 0",
              }}
            >
              <span
                aria-hidden="true"
                data-testid="drift-player-list-dot"
                data-glyph={statusIcon(p.state).glyph}
                title={p.state}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: statusDotColor(p.state),
                  display: "inline-block",
                  flex: "0 0 auto",
                }}
              />
              <span style={{ flex: "1 1 auto" }}>{p.callsign}</span>
              {p.isYou && (
                <span
                  data-testid="drift-player-list-you"
                  style={{
                    color: "#8b949e",
                    fontStyle: "italic",
                    fontSize: 10,
                  }}
                >
                  (you)
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
