/**
 * System-wide text chat (TASK-16).
 *
 * The chat pipeline is intentionally minimal: every player in a shard
 * sees every message, with rate limiting + sanitization. No private
 * messages, channels, or history-in-the-database in v1.
 *
 * ## Architecture
 *
 * Three small pieces cooperate:
 *
 *   1. **`ChatRingBuffer`** — per-shard rolling history. Holds the
 *      last 100 messages so a newly-joined client gets context when
 *      `enter_system` ships `chat: ChatEntry[]`. Old entries are
 *      silently dropped once the buffer is full (FIFO eviction).
 *      No persistence across shard reaps: a reaped shard starts a
 *      fresh buffer.
 *
 *   2. **`ChatWindowLimiter`** — per-connection rate limiter. The
 *      spec calls for *more than 5 messages in 10 seconds* to be
 *      dropped (TASK-16 acceptance). The implementation reuses the
 *      sliding-window pattern from TASK-65's `ChatLimiter` but with
 *      the TASK-16 values; the older TASK-65 limiter is left intact
 *      so its dedicated tests still pass.
 *
 *   3. **`sanitizeChatText` / `validateChatText`** — text transforms
 *      applied **before** the rate-limit check so a malicious client
 *      can't pollute the log with control bytes. The pipeline order
 *      is: validate (length / empty) → sanitize (control chars) →
 *      rate-limit → broadcast.
 *
 * ## Sanitization rules
 *
 * - Strip ASCII control bytes `0x00-0x1F` except `\n` and `\t` (so a
 *   pasted paragraph still renders readably).
 * - Strip DEL (`0x7F`).
 * - Strip zero-width characters and bidi marks (the common
 *   filename-spoofing / homograph attack vectors).
 * - Collapse runs of whitespace to a single space.
 *
 * No HTML-escape: the client renders text via plain JSX (React auto-
 * escapes), so `<img src=x onerror=alert(1)>` survives sanitization
 * unchanged but renders as inert text on the client (TASK-16
 * acceptance: "XSS test renders as inert text").
 *
 * ## Broadcast model
 *
 * The server emits a single `{type: "chat", payload: ChatEntry}` frame
 * per accepted message to **every connection in the shard**,
 * including the sender. Sender echo is intentional: it lets the
 * client collapse its optimistic-send UI on receipt rather than
 * guessing when the message is "delivered".
 *
 * @see @shared/protocol/schemas.ts for the wire shapes.
 * @see ./shard/index.ts for the per-shard integration.
 * @see ./ws.handlers.ts#onChat for the inbound dispatcher.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum characters in a single chat message *after trim* (TASK-16
 * acceptance). Server-side enforcement; the wire-level `ChatSchema`
 * carries a slightly wider window so the parser can emit a
 * structured `invalid-message` rather than crashing.
 */
export const CHAT_MAX_LEN = 200;

/** Width of the per-shard history buffer (TASK-16 acceptance). */
export const CHAT_HISTORY_LIMIT = 100;

/** Sliding-window length (ms) for the rate limiter. */
export const CHAT_WINDOW_MS = 10_000;

/** Maximum accepted messages within `CHAT_WINDOW_MS` (TASK-16). */
export const CHAT_WINDOW_MAX = 5;

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Regular expression that matches every byte / code-point we strip
 * from incoming chat text. Built from explicit ranges so the result
 * is auditable without an interactive regex debugger.
 *
 * Strip list:
 *   - `[\u0000-\u0008\u000B-\u001F\u007F]` — ASCII controls except
 *     `\n` (`\u000A`) and `\t` (`\u0009`). DEL included.
 *   - `[\u200B-\u200F]` — zero-width / bidi marks (the homograph
 *     attack vector).
 *   - `[\u202A-\u202E]` — bidi embedding controls (the right-to-left
 *     override attack vector).
 *   - `[\uFEFF]` — BOM / zero-width no-break space.
 */
// eslint-disable-next-line no-control-regex -- intentional: chat sanitization strip list (TASK-16).
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\uFEFF]/gu;

/**
 * Sanitize a chat message. Returns the cleaned string.
 *
 * The function is pure — no global state, no throws — so callers
 * can safely pass user input through it before any further
 * validation. Whitespace is NOT trimmed here; `validateChatText` is
 * responsible for the empty-after-trim check (so we don't strip
 * legitimate leading/trailing whitespace from messages that happen
 * to look empty before a sanitize pass).
 */
export function sanitizeChatText(input: string): string {
  // Replace control characters with a single space, then collapse
  // runs of whitespace so the visible result is human-readable.
  // Order matters: strip controls first so the whitespace collapse
  // can't accidentally hide a control byte.
  return input.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Why a chat message was rejected. Drives the wire `error.message`. */
export type ChatValidationReason = "empty" | "too-long" | "not-a-string";

/** Outcome of `validateChatText`. */
export type ChatValidationResult =
  | { accepted: true; trimmed: string }
  | { accepted: false; reason: ChatValidationReason; message: string };

/**
 * Validate a chat message. The check is performed **before**
 * sanitization so the trim operates on the raw input — a message
 * consisting only of control characters is "empty after trim" and
 * gets a different error than "too long".
 *
 * Length is measured on the trimmed string (TASK-16 acceptance:
 * "<= 200 chars after trim"). The wire `ChatSchema` is slightly
 * wider so a hostile client can't bypass the parser-level guard,
 * but anything that survives parsing but exceeds the post-trim cap
 * is rejected here.
 */
export function validateChatText(raw: unknown): ChatValidationResult {
  if (typeof raw !== "string") {
    return {
      accepted: false,
      reason: "not-a-string",
      message: "chat.text must be a string",
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      accepted: false,
      reason: "empty",
      message: "chat.text must be non-empty",
    };
  }
  if (trimmed.length > CHAT_MAX_LEN) {
    return {
      accepted: false,
      reason: "too-long",
      message: `chat.text exceeds ${CHAT_MAX_LEN} characters after trim`,
    };
  }
  return { accepted: true, trimmed };
}

/** Human-readable message for a validation rejection. */
export function chatValidationMessage(
  reason: Exclude<ChatValidationResult, { accepted: true }>["reason"],
): string {
  switch (reason) {
    case "empty":
      return "chat.text must be non-empty";
    case "too-long":
      return `chat.text exceeds ${CHAT_MAX_LEN} characters after trim`;
    case "not-a-string":
      return "chat.text must be a string";
  }
}

// ---------------------------------------------------------------------------
// ChatRingBuffer — per-shard history
// ---------------------------------------------------------------------------

/**
 * One entry in the per-shard history. The wire shape (`ChatEntry`)
 * is identical so the buffer can be serialized with no translation.
 */
export interface ChatEntry {
  /** Server-assigned monotonic id (per-shard). */
  id: string;
  /** Author callsign. */
  author: string;
  /** Sanitized text. */
  text: string;
  /** Server-assigned timestamp (ms since epoch). */
  ts: number;
}

/**
 * Rolling FIFO buffer for chat history.
 *
 * - Capacity: `CHAT_HISTORY_LIMIT` (default 100).
 * - Insertion order is preserved; older entries are evicted FIFO.
 * - `snapshot()` returns a fresh array each call so the wire
 *   serializer (`enter_system.chat`) can serialize without
 *   aliasing. Callers that need referential stability should cache
 *   the array themselves.
 *
 * Concurrency: single-writer. Mutations happen on the WS message
 * tick; the broadcast loop reads only via `snapshot()`.
 */
export class ChatRingBuffer {
  private readonly entries: ChatEntry[] = [];
  private nextId = 0;

  /**
   * Append a message to the buffer. The caller computes the
   * timestamp + assigns the id; we only enforce the cap.
   *
   * Returns the entry that was actually stored (a copy with the
   * assigned `id`).
   */
  append(args: { author: string; text: string; ts: number }): ChatEntry {
    const id = `chat-${++this.nextId}`;
    const entry: ChatEntry = {
      id,
      author: args.author,
      text: args.text,
      ts: args.ts,
    };
    this.entries.push(entry);
    if (this.entries.length > CHAT_HISTORY_LIMIT) {
      this.entries.splice(0, this.entries.length - CHAT_HISTORY_LIMIT);
    }
    return entry;
  }

  /** Read-only snapshot of the current history (new array each call). */
  snapshot(): ChatEntry[] {
    return [...this.entries];
  }

  /** Number of stored messages (test-only). */
  size(): number {
    return this.entries.length;
  }

  /** Drop every entry (called when the shard is reaped + rebuilt). */
  clear(): void {
    this.entries.length = 0;
  }
}

// ---------------------------------------------------------------------------
// ChatWindowLimiter — per-connection sliding window
// ---------------------------------------------------------------------------

/** Outcome of `ChatWindowLimiter.check()`. */
export type ChatWindowCheckResult = { accepted: true } | { accepted: false; reason: "too-many" };

/**
 * Per-connection sliding-window limiter (TASK-16).
 *
 * Reuses the shape of TASK-65's `ChatLimiter` (sliding window of
 * accepted-message timestamps) but with TASK-16's bounds:
 * `CHAT_WINDOW_MAX` (5) messages within `CHAT_WINDOW_MS` (10 s).
 * The old TASK-65 limiter is left intact for its dedicated tests;
 * this one is wired into the new chat pipeline (see `ws.handlers.ts`).
 *
 * Violations do NOT count toward `FloodTracker` escalation: a
 * dropped chat message is its own thing — the spec only asks for a
 * structured `rate-limited` error frame, not a flood close.
 */
export class ChatWindowLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly windowMax: number,
    private readonly nowFn: () => number,
  ) {
    if (windowMs <= 0 || windowMax <= 0) {
      throw new Error("ChatWindowLimiter requires positive window and max");
    }
  }

  /**
   * Decide whether a chat message at time `now` (defaulting to the
   * injected clock) is allowed. On accept the timestamp is recorded
   * so future checks see this one. Rejections do NOT record state.
   */
  check(now?: number): ChatWindowCheckResult {
    const t = typeof now === "number" ? now : this.nowFn();
    const cutoff = t - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.windowMax) {
      return { accepted: false, reason: "too-many" };
    }
    this.timestamps.push(t);
    return { accepted: true };
  }

  /** Test-only: current window count. */
  sizeForTesting(now?: number): number {
    const t = typeof now === "number" ? now : this.nowFn();
    const cutoff = t - this.windowMs;
    let n = 0;
    for (const ts of this.timestamps) {
      if (ts >= cutoff) n += 1;
    }
    return n;
  }
}

/** Human-readable message for a window rejection. */
export function chatWindowMessage(): string {
  return `chat rate exceeded (max ${CHAT_WINDOW_MAX} messages per ${CHAT_WINDOW_MS} ms)`;
}
