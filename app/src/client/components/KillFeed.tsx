/**
 * KillFeed HUD widget — TASK-47.
 *
 * Top-center HUD column (under the chat log, above the canvas)
 * showing the last 5 kills in the local player's system. Each
 * entry:
 *
 *   - PvP (player kills player) — white text.
 *   - PvAI (player kills AI, AI kills AI is suppressed) — grey text.
 *   - Fades out over the last 1 s of its 10 s TTL.
 *   - Shows the attacker callsign, a weapon tag, and the victim
 *     callsign (`"A ▸ MISSILE ▸ B"`).
 *
 * The store + redux-free React pattern matches the existing
 * `WeightBar` / `CargoPanel` convention — `useSyncExternalStore`
 * reads `KillFeedStore.snapshot()` which reaps expired entries on
 * every read. The HUD itself is dumb: it renders whatever the
 * snapshot gives it, no GC concerns in the React layer.
 *
 * The `isPlayerId` predicate is supplied via the calling site
 * so the WS layer can pass a real predicate built from the
 * current `presence` roster. Tests pass a fixed predicate.
 *
 * @see ../combat/killFeed.ts for the store + TTL semantics.
 */
import { useSyncExternalStore } from "react";
import type * as React from "react";

import {
  type KillFeedStore,
  formatKillLine,
  KILL_FEED_MAX_ENTRIES,
  KILL_FEED_TTL_MS,
} from "../combat/killFeed.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KillFeedProps {
  /** Live kill-feed store. */
  store: KillFeedStore;
  /**
   * Optional override for the CSS top offset (px). Spec defaults
   * to 16 px from the top; a future TASK-50 layout pass may
   * shift the column under the chat panel.
   */
  topPx?: number;
  /** Test seam — render with empty entries (no live store). */
  initialEmpty?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Top-center kill-feed HUD column. Renders up to
 * `KILL_FEED_MAX_ENTRIES` rows; expires after `KILL_FEED_TTL_MS`.
 * Hides itself when the snapshot is empty (so the column doesn't
 * occupy space at boot or after a long quiet spell).
 *
 * Uses CSS opacity transitions for the fade — no keyframes / no
 * WebGL — so the column never causes an HUD hitch.
 */
export function KillFeed(props: KillFeedProps): React.JSX.Element | null {
  const entries = useSyncExternalStore(
    (listener) => props.store.subscribe(listener),
    () => props.store.snapshot(),
    () => props.store.getEntries(),
  );

  // Initial-empty test seam — render with no entries.
  if (props.initialEmpty) {
    return null;
  }

  if (entries.length === 0) {
    return null;
  }

  // Render newest entry at the TOP (so the most recent kill is
  // closest to the chat column above). The store uses FIFO order
  // internally (oldest first); reverse here.
  const ordered = [...entries].slice(-KILL_FEED_MAX_ENTRIES).reverse();

  return (
    <div
      data-testid="drift-kill-feed"
      style={{
        position: "fixed",
        top: props.topPx ?? 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 950,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        pointerEvents: "none",
        fontFamily: "system-ui, sans-serif",
        userSelect: "none",
      }}
    >
      {ordered.map((e) => {
        // 1-second fade-over for entries in the last second of
        // their TTL. Cheap CSS opacity, no keyframes.
        const fadeStartMs = e.expiresAt - 1_000;
        const isFading = Date.now() >= fadeStartMs;
        const style: React.CSSProperties = {
          padding: "4px 10px",
          background: "rgba(20, 24, 32, 0.78)",
          border: e.isPvP
            ? "1px solid rgba(255, 255, 255, 0.35)"
            : "1px solid rgba(154, 166, 178, 0.25)",
          borderRadius: 4,
          color: e.isPvP ? "#ffffff" : "#9aa6b2",
          fontSize: 12,
          letterSpacing: "0.04em",
          minWidth: 200,
          textAlign: "center",
          opacity: isFading ? 0.4 : 1,
          transition: "opacity 1s linear",
        };
        return (
          <div
            key={e.id}
            data-testid="drift-kill-feed-row"
            data-pvp={e.isPvP ? "true" : "false"}
            style={style}
          >
            {formatKillLine(e)}
          </div>
        );
      })}
      {/* `KILL_FEED_MAX_ENTRIES` + `KILL_FEED_TTL_MS` are re-exported
          into the test harness via the package barrel. The constants
          themselves are pinned in `killFeed.test.ts`. */}
      <span style={{ display: "none" }}>{KILL_FEED_TTL_MS}</span>
    </div>
  );
}
