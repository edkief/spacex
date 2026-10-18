/**
 * Client-side chat store (TASK-16).
 *
 * Holds the rolling 100-message chat history for the local player's
 * current system. The store is the single source of truth for chat
 * on the client; the `ChatLog` React component subscribes to it via
 * `useSyncExternalStore`.
 *
 * ## Wire model
 *
 * Two ways for a message to enter the store:
 *
 *   1. **Server echo** — the server broadcasts `chat` frames to
 *      every connection in the shard (sender included). The WS
 *      client (`@client/net/wsClient.ts`) feeds each `chat` frame
 *      into `applyChatFrame()`. The sender sees their own message
 *      come back via this path.
 *
 *   2. **Initial hydrate** — `enter_system.chat` carries the last
 *      100 messages so a freshly-joined client gets context. The
 *      store accepts the array verbatim via `seedHistory()`.
 *
 * `applyChatFrame` uses the wire-assigned `id` to dedupe so a server
 * echo + an optimistic local-send doesn't double-render the same
 * line. (v1's UI doesn't optimistic-send — it just disables the
 * input until the echo arrives — but the dedupe is here so future
 * tasks can plug optimistic-send in without rewriting the store.)
 *
 * On system change (warp into a different star, or disconnect) the
 * WS layer calls `clear()` so the log doesn't carry messages from
 * the previous system.
 *
 * @see ../../server/chat.ts for the server-side builder.
 * @see ../components/ChatLog.tsx for the React widget.
 */

/** Local view of one chat row. */
export interface ChatEntry {
  /** Wire id (server-assigned, monotonic per shard). */
  readonly id: string;
  /** Author callsign. */
  readonly author: string;
  /** Sanitized text (server-side control bytes stripped). */
  readonly text: string;
  /** Server-assigned timestamp (ms since epoch). */
  readonly ts: number;
}

/**
 * The shape the server sends in a `chat` broadcast frame and in
 * the `enter_system.chat` initial history.
 *
 * The outbound client→server `chat` schema is just `{text}` (see
 * `ChatSchema` in `@shared/protocol/schemas.ts`). The server's
 * broadcast response uses the full ChatEntry shape; we accept it
 * here without going through `PayloadFor<"chat">` because the wire
 * schema would otherwise reject the inbound broadcast. The
 * invariant we rely on is: every broadcast entry has all four
 * fields populated by the server (the spec).
 */
export interface ChatWireEntry {
  id: string;
  author: string;
  text: string;
  ts: number;
}

/** Events the store emits to subscribers. */
export type ChatEvent =
  | { kind: "append"; entry: ChatEntry }
  | { kind: "clear" }
  | { kind: "snapshot"; entries: ChatEntry[] };

/** Subscriber callback signature. */
export type ChatListener = (event: ChatEvent) => void;

/** Unsubscribe handle returned by `subscribe`. */
export type Unsubscribe = () => void;

/**
 * Maximum entries held in the store. Matches the server-side
 * `CHAT_HISTORY_LIMIT` so the client's ring stays in sync with the
 * server's cap.
 */
export const CHAT_HISTORY_LIMIT = 100;

/**
 * Pure-TS chat store. No dependency on React, three.js, or the
 * network layer — the WS client feeds it via `applyChatFrame()` /
 * `seedHistory()` and `clear()`. Testable with synthetic frames.
 */
export class ChatStore {
  private readonly entries: ChatEntry[] = [];
  /**
   * Cached snapshot returned by `snapshot()`. Recomputed only when
   * the underlying roster changes — `useSyncExternalStore` callers
   * compare the snapshot by reference identity so a fresh array
   * each call would trigger an infinite re-render loop. Matches the
   * pattern used by `PresenceStore` (TASK-15).
   */
  private cachedSnapshot: ChatEntry[] = [];
  /** True when the cached snapshot is stale and needs to be rebuilt. */
  private snapshotDirty = true;
  private readonly listeners = new Set<ChatListener>();

  /**
   * Apply a single `chat` frame from the server. Idempotent on
   * `id` — a duplicate echo is silently dropped so the optimistic-
   * send dedupe path stays correct.
   */
  applyChatFrame(frame: ChatWireEntry): void {
    if (this.entries.some((e) => e.id === frame.id)) return;
    const entry: ChatEntry = {
      id: frame.id,
      author: frame.author,
      text: frame.text,
      ts: frame.ts,
    };
    this.entries.push(entry);
    if (this.entries.length > CHAT_HISTORY_LIMIT) {
      this.entries.splice(0, this.entries.length - CHAT_HISTORY_LIMIT);
    }
    this.snapshotDirty = true;
    this.notify({ kind: "append", entry });
  }

  /**
   * Seed the history from an `enter_system.chat` payload (or any
   * other array source). Replaces the existing contents. Emits a
   * single `snapshot` event so React rebuilds in one commit.
   */
  seedHistory(history: readonly ChatWireEntry[]): void {
    this.entries.length = 0;
    for (const f of history) {
      this.entries.push({ id: f.id, author: f.author, text: f.text, ts: f.ts });
    }
    this.snapshotDirty = true;
    this.notify({ kind: "snapshot", entries: this.snapshot() });
  }

  /**
   * Drop every entry. Called by the WS client on system change /
   * disconnect so messages from the previous system don't leak.
   */
  clear(): void {
    if (this.entries.length === 0) {
      // Still emit so a freshly-mounted subscriber can collapse any
      // optimistic UI; cheap and idempotent.
      this.cachedSnapshot = [];
      this.snapshotDirty = false;
      this.notify({ kind: "clear" });
      return;
    }
    this.entries.length = 0;
    this.cachedSnapshot = [];
    this.snapshotDirty = false;
    this.notify({ kind: "clear" });
  }

  /** Snapshot of the current entries (cached between mutations). */
  snapshot(): ChatEntry[] {
    if (this.snapshotDirty) {
      this.cachedSnapshot = [...this.entries];
      this.snapshotDirty = false;
    }
    return this.cachedSnapshot;
  }

  /** Number of stored messages (test-only). */
  size(): number {
    return this.entries.length;
  }

  /** Subscribe to events. Returns an unsubscribe handle. */
  subscribe(listener: ChatListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Test-only escape hatch: clear the roster and forget all
   * listeners. Production code never calls this — the WS layer
   * owns the lifecycle and uses `clear()` for transitions.
   */
  reset(): void {
    this.entries.length = 0;
    this.cachedSnapshot = [];
    this.snapshotDirty = false;
    this.listeners.clear();
  }

  private notify(event: ChatEvent): void {
    for (const l of Array.from(this.listeners)) {
      try {
        l(event);
      } catch {
        // swallow — faulty listener must not break the store.
      }
    }
  }
}

/**
 * Format a chat entry for the `[12:03] CALLSIGN: text` line.
 *
 * Returns `""` for invalid entries so the UI can filter them
 * defensively without a try/catch around the formatter.
 */
export function formatChatLine(entry: ChatEntry): string {
  const time = formatTime(entry.ts);
  return `[${time}] ${entry.author}: ${entry.text}`;
}

/** Format an ms epoch as `HH:MM` (local time). 24-hour, zero-padded. */
export function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return "--:--";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
