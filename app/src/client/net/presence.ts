/**
 * Client-side presence store (TASK-15).
 *
 * Holds the in-system player roster the HUD renders. The store is
 * the single source of truth for "who is currently in my system" on
 * the client; the React layer subscribes to it via a small event
 * emitter and re-renders only when the roster changes (no per-
 * snapshot churn — the server broadcasts `presence` frames only when
 * the roster actually changes).
 *
 * ## Wire model
 *
 * The server pushes a single canonical `presence` frame per roster
 * change (see `PresenceSchema` in `@shared/protocol/schemas.ts`).
 * The frame carries the **full current roster** — there is no
 * separate `presence_join` / `presence_leave` wire shape today. The
 * store diffs the new roster against the previous one to derive
 * join / leave events locally; the toast component listens to those
 * events instead of having to replay the roster diff itself.
 *
 * On system change (e.g. warp into a different star) the WS layer
 * calls `leaveAll()` which fires a synthetic `leave` event for every
 * player currently in the roster. The leaving player is filtered
 * out via `setOwnCallsign()` — see the public docs on `setOwnCallsign`
 * for why.
 *
 * ## Subscriber model
 *
 * `subscribe(listener)` returns an `unsubscribe` function so React
 * effects clean up properly. The listener signature is
 * `(event: PresenceEvent) => void`. Events never carry the listener's
 * own callsign — see `PresenceEvent` for the per-event shape.
 *
 * ## "you" marker
 *
 * The store does **not** hide the local player's row. The HUD
 * chooses how to render it (the spec is "excludes own callsign from
 * the list but shows a '(you)' marker"). The store exposes the
 * `isYou` flag on every entry so the HUD can render the marker
 * without re-querying the store.
 *
 * @see ./prediction.ts for the sibling client-side store (local
 *      ship state).
 * @see ../../server/galaxy/presence.ts for the server-side builder
 *      that produces the canonical roster.
 */

import type { PayloadFor, ProtocolPlayerActivity } from "@shared/protocol/index.js";

/**
 * One row of the canonical roster from the server's `presence`
 * frame. Derived from the wire schema so the store doesn't have to
 * import the zod schema directly (and so a future TASK-15 protocol
 * bump that adds new fields surfaces in one place).
 */
export type WirePresenceEntry = PayloadFor<"presence">["players"][number];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One row of the client-side roster. Mirrors the server's
 * `PresenceEntry` with a derived `isYou` flag so the HUD can render
 * the "(you)" marker without a second lookup.
 *
 * `onFoot` is reserved for TASK-36 (character state); when the
 * server starts emitting `state: "onfoot"` the field gets populated
 * here without a store API change.
 */
export interface PresencePlayer {
  /** Server-assigned player id (matches `Connection.playerId`). */
  readonly playerId: string;
  /** Callsign shown in the HUD. */
  readonly callsign: string;
  /** Persisted ship id the player is flying. */
  readonly shipId: string | null;
  /** Player activity tag (docked/flying/onfoot) — TASK-36 will set "onfoot". */
  readonly state: ProtocolPlayerActivity;
  /** True when this row is the local player (callsign matches `setOwnCallsign`). */
  readonly isYou: boolean;
  /**
   * Wall-clock ms when this row was last refreshed from a presence
   * frame. Captured in case future tasks want to surface a "last
   * seen" indicator (out of v1 scope per the spec).
   */
  readonly lastSeenAt: number;
}

/** Events the store emits to subscribers. */
export type PresenceEvent =
  | { kind: "join"; player: PresencePlayer }
  | { kind: "leave"; player: PresencePlayer }
  | { kind: "snapshot"; players: PresencePlayer[] };

/** Subscriber callback signature. */
export type PresenceListener = (event: PresenceEvent) => void;

/** Unsubscribe handle returned by `subscribe`. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// PresenceStore
// ---------------------------------------------------------------------------

/**
 * Pure-TS presence store. No dependency on three.js, React, or the
 * network layer — the WS client feeds it via `applyPresenceFrame()`
 * and `leaveAll()`. Testable with synthetic rosters.
 *
 * Threading model: single-threaded. All mutators run on the JS event
 * loop tick that delivered the frame; React renders observe the
 * post-mutation state via the next `useSyncExternalStore` snapshot.
 */
export class PresenceStore {
  /**
   * The current roster keyed by player id. Insertion-ordered so the
   * HUD can render in the order the server delivered (which is the
   * order the players joined — same order the chat/away combo lands
   * later in TASK-16).
   */
  private readonly players = new Map<string, PresencePlayer>();

  /**
   * Cached snapshot returned by `snapshot()`. Recomputed only when
   * the underlying roster changes — `useSyncExternalStore` callers
   * (the HUD widgets) compare the snapshot by reference identity
   * so a fresh array each call would trigger an infinite re-render
   * loop. The cache is invalidated by `markDirty()` after every
   * mutation.
   */
  private cachedSnapshot: PresencePlayer[] = [];

  /** True when the cached snapshot is stale and needs to be rebuilt. */
  private snapshotDirty = true;

  /**
   * Set of listeners subscribed via `subscribe()`. Stored as a Set
   * so each `(event)` notification only fires once per registered
   * subscriber (a stale React effect could otherwise double-subscribe
   * if `useEffect`'s cleanup runs late).
   */
  private readonly listeners = new Set<PresenceListener>();

  /**
   * Local player's callsign. `null` until the WS layer reports who
   * we are (the auth handshake result). When set, the matching roster
   * entry has `isYou: true` — the HUD uses that flag for the "(you)"
   * marker.
   */
  private ownCallsign: string | null = null;

  /**
   * Apply the local player's callsign. The WS layer calls this once
   * the `auth_ok` frame arrives. Setting it twice with the same value
   * is a no-op; setting it with a different value clears the prior
   * `isYou` flag and re-evaluates the new roster.
   *
   * The store never broadcasts a synthetic `leave` for the old
   * "you" row — the roster still contains the row, just with
   * `isYou: false` until the next presence frame matches the new
   * callsign (which happens on the very next server tick).
   */
  setOwnCallsign(callsign: string | null): void {
    if (callsign === this.ownCallsign) return;
    this.ownCallsign = callsign;
    // Re-stamp the `isYou` flag on every row without otherwise
    // touching the roster. The next subscriber snapshot reads
    // through `snapshot()` which derives `isYou` from `ownCallsign`,
    // so this update is "free" — we only need to notify listeners
    // if a row's flag actually flipped.
    let changed = false;
    for (const [id, p] of this.players) {
      const isYou = p.callsign === callsign;
      if (p.isYou !== isYou) {
        this.players.set(id, { ...p, isYou });
        changed = true;
      }
    }
    if (changed) {
      const snapshot: PresencePlayer[] = Array.from(this.players.values());
      this.cachedSnapshot = snapshot;
      this.snapshotDirty = false;
      this.notify({ kind: "snapshot", players: snapshot });
    }
  }

  /**
   * Apply a `presence` frame from the server. Diffs the new roster
   * against the previous one and emits `join` / `leave` events for
   * the deltas, then a final `snapshot` event so the HUD can rebuild
   * in one render pass (React batches the join/leave + snapshot into
   * a single commit when wrapped in `unstable_batchedUpdates`).
   *
   * Players whose state changed (e.g. docked → flying) keep their
   * row but get a fresh `lastSeenAt`. The store does not emit a
   * separate `state` event — the snapshot event delivers the new
   * state implicitly because subscribers that care (HUD) re-read
   * the whole roster on every event.
   *
   * Players whose callsign matches `ownCallsign` are stamped with
   * `isYou: true` so the HUD can render the marker.
   */
  applyPresenceFrame(frame: PayloadFor<"presence">, nowMs: number = Date.now()): void {
    const newRoster = new Map<string, WirePresenceEntry>();
    for (const entry of frame.players) {
      newRoster.set(entry.playerId, entry);
    }

    // 1. Detect leaves: anyone in the old roster but missing from the
    //    new one is gone. Emit `leave` events in stable order
    //    (oldest-first) so toasts disappear in the same order they
    //    appeared.
    const leftPlayerIds: string[] = [];
    for (const id of this.players.keys()) {
      if (!newRoster.has(id)) leftPlayerIds.push(id);
    }
    for (const id of leftPlayerIds) {
      const p = this.players.get(id);
      if (!p) continue;
      this.players.delete(id);
      this.notify({ kind: "leave", player: p });
    }

    // 2. Detect joins + updates. Anything in the new roster that is
    //    missing from the old one is a join; anything present in both
    //    is an update (state / lastSeen) and silently replaces the
    //    row in place.
    for (const [id, entry] of newRoster) {
      const previous = this.players.get(id);
      if (!previous) {
        const player: PresencePlayer = {
          playerId: entry.playerId,
          callsign: entry.callsign,
          shipId: entry.shipId,
          state: entry.state,
          isYou: entry.callsign === this.ownCallsign,
          lastSeenAt: nowMs,
        };
        this.players.set(id, player);
        this.notify({ kind: "join", player });
      } else if (
        previous.state !== entry.state ||
        previous.shipId !== entry.shipId ||
        previous.callsign !== entry.callsign
      ) {
        const updated: PresencePlayer = {
          playerId: entry.playerId,
          callsign: entry.callsign,
          shipId: entry.shipId,
          state: entry.state,
          isYou: entry.callsign === this.ownCallsign,
          lastSeenAt: nowMs,
        };
        this.players.set(id, updated);
        // State updates don't fire a toast — the HUD re-renders the
        // existing row. Subscribers that want to react can compare
        // `previous` vs `updated` in the snapshot.
      }
    }

    // 3. Build the final roster array LOCALLY so the snapshot event
    //    carries the full post-mutation state, regardless of whether
    //    any subscriber's listener re-entered `snapshot()` mid-loop
    //    (which would otherwise rebuild the cache prematurely and
    //    leave it stale for the final emit). The cache is updated
    //    BEFORE the notify so a listener that calls `snapshot()`
    //    during the re-render sees the fresh array reference.
    const snapshot: PresencePlayer[] = Array.from(this.players.values());
    this.cachedSnapshot = snapshot;
    this.snapshotDirty = false;
    this.notify({ kind: "snapshot", players: snapshot });
  }

  /**
   * Clear the roster and emit a synthetic `leave` event for every
   * player currently in it. Called by the WS layer when the local
   * player warps to a new system or disconnects — the spec's
   * "presence on system change" requirement.
   *
   * Listeners always see at least one event per call (the snapshot
   * event is unconditional). The order is: one `leave` per
   * remaining player, then the empty `snapshot`.
   */
  leaveAll(): void {
    if (this.players.size === 0) {
      // Still fire a snapshot so subscribers re-render to the empty
      // state (defensive — a hot reload may have re-attached with
      // stale internal state).
      this.notify({ kind: "snapshot", players: [] });
      this.cachedSnapshot = [];
      this.snapshotDirty = false;
      return;
    }
    // Snapshot the keys before mutating — `leave` events fire in
    // insertion order (oldest player first) so the toasts disappear
    // in the same order they appeared.
    const ids = Array.from(this.players.keys());
    for (const id of ids) {
      const p = this.players.get(id);
      if (!p) continue;
      this.players.delete(id);
      this.notify({ kind: "leave", player: p });
    }
    this.cachedSnapshot = [];
    this.snapshotDirty = false;
    this.notify({ kind: "snapshot", players: [] });
  }

  /**
   * Snapshot of the current roster (oldest-first, matching the
   * server's join order). Returns a cached array reference between
   * mutations so React's `useSyncExternalStore` snapshot
   * comparison stays referentially stable — see `cachedSnapshot`.
   */
  snapshot(): PresencePlayer[] {
    if (this.snapshotDirty) {
      this.cachedSnapshot = Array.from(this.players.values());
      this.snapshotDirty = false;
    }
    return this.cachedSnapshot;
  }

  /**
   * True when no players are tracked. Used by tests + the HUD to
   * decide whether to render an "alone" placeholder.
   */
  isEmpty(): boolean {
    return this.players.size === 0;
  }

  /**
   * Local player's callsign. Returns `null` before the WS layer has
   * delivered `auth_ok` (i.e. pre-handshake).
   */
  ownCallsignValue(): string | null {
    return this.ownCallsign;
  }

  /**
   * Subscribe to roster events. Returns an `unsubscribe` function.
   * The listener fires synchronously on every event; React's
   * `useSyncExternalStore` relies on the synchronous read so the
   * listener does not need its own queue.
   *
   * Listeners registered twice with the same reference fire only
   * once per event (Set semantics). Tests use the count to assert
   * the store doesn't double-fire when an effect re-runs.
   */
  subscribe(listener: PresenceListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Test-only escape hatch: clear the roster and forget all
   * listeners. Production code never calls this — the WS layer
   * owns the lifecycle and uses `leaveAll()` for transitions.
   */
  reset(): void {
    this.players.clear();
    this.listeners.clear();
    this.ownCallsign = null;
    this.snapshotDirty = true;
    this.cachedSnapshot = [];
  }

  /** Fan-out a single event to every subscriber. */
  private notify(event: PresenceEvent): void {
    // Snapshot the listener set so a subscriber that unsubscribes
    // itself (or another) mid-iteration doesn't mutate the Set
    // during traversal.
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // Swallow — a faulty listener must not break the rest of
        // the roster update. The store is the source of truth; the
        // HUD's error boundary will catch the throw downstream.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so the toast component can build its
// "callsign joined" / "callsign left" strings without importing the
// store class (keeps the toast component testable in isolation).
// ---------------------------------------------------------------------------

/**
 * Render the toast headline for a presence event. Centralised so
 * the wording is consistent between the toast component, the
 * Playwright smoke test, and any future surfaces (chat / history).
 */
export function toastTextFor(event: PresenceEvent): string {
  if (event.kind === "join") {
    return `${event.player.callsign} joined`;
  }
  if (event.kind === "leave") {
    return `${event.player.callsign} left`;
  }
  // Snapshot events carry no toast — the per-row state lives in
  // the snapshot array the HUD already consumes.
  return "";
}

/**
 * Resolve the status icon for the HUD player list (TASK-36).
 *
 * Each entry returns a small SVG-style glyph (an inline SVG path
 * or a short text symbol) the PlayerList renders next to the
 * callsign so the player can tell ships from characters at a
 * glance. The function is pure — it does not depend on the
 * PlayerList's internal layout.
 *
 *   - `flying`   → ✈ plane glyph (ship is in flight)
 *   - `docked`   → ⏚ dock glyph (ship is on a pad)
 *   - `onfoot`   → 🚶 walking-figure glyph (character is disembarked)
 *
 * Centralised so the wording stays consistent with the spec's
 * "walking figure vs ship" requirement and so a future task can
 * swap the glyph library without touching the PlayerList.
 */
export interface StatusIcon {
  /** Single-character or short text representation (for legacy rendering). */
  readonly glyph: string;
  /** CSS color string for the glyph. */
  readonly color: string;
  /** Inline SVG path data so the PlayerList can render at any DPI. */
  readonly svgPath: string;
}

export function statusIcon(state: ProtocolPlayerActivity): StatusIcon {
  switch (state) {
    case "flying":
      return {
        glyph: "▲",
        color: "#7ee787",
        // Plane (triangle pointing up) silhouette.
        svgPath: "M -4 3 L 4 3 L 0 -4 Z",
      };
    case "docked":
      return {
        glyph: "■",
        color: "#8b949e",
        // Square — visually "stationary".
        svgPath: "M -4 -4 L 4 -4 L 4 4 L -4 4 Z",
      };
    case "onfoot":
      return {
        glyph: "☻",
        color: "#f0b76b",
        // Walking figure: small head circle + body line.
        svgPath: "M 0 -4 a 2 2 0 1 0 0.01 0 Z M 0 -1 L 0 3 M -3 1 L 3 1 M -2 4 L 0 1 L 2 4",
      };
  }
}

/**
 * Resolve the status-dot colour for the HUD player list. The store
 * keeps `state` as the canonical tag; this helper maps it to a CSS
 * colour so the HUD component stays presentational.
 *
 *   - `flying`   → green (default)
 *   - `docked`   → grey
 *   - `onfoot`   → amber (TASK-36)
 */
export function statusDotColor(state: ProtocolPlayerActivity): string {
  switch (state) {
    case "flying":
      return "#7ee787"; // mint
    case "docked":
      return "#8b949e"; // grey
    case "onfoot":
      return "#f0b76b"; // amber
  }
}
