/**
 * Per-connection rate limiting primitives (TASK-65).
 *
 * The server uses three independent mechanisms:
 *
 *   - `TokenBucket` — general "20 msg/s, burst 40" gate fired *before*
 *     envelope parsing so an excess frame is dropped as cheaply as
 *     possible. Each excess frame is turned into a structured
 *     `{code:"rate-limited"}` error frame and dropped from the dispatch
 *     path.
 *   - `FloodTracker` — sliding window of recent rate-limit violations.
 *     Three within 10 seconds → connection closed with WS code 4009
 *     and reason `flooded`. Deliberately independent of TASK-64's
 *     50-strike validation counter so a client flooding isn't
 *     conflated with a client sending malformed JSON.
 *   - `ChatLimiter` — chat-specific gate combining the 2-second
 *     minimum gap, the 280-character max length, and the 10/30 s
 *     sliding window. Chat-limit violations count toward the flood
 *     tracker so a client spamming chat is escalated exactly like a
 *     client flooding the general message channel.
 *
 * All three accept an injected `now()` for deterministic tests. The
 * server's `attachWs` passes its own `options.now` clock so the unit
 * tests can drive the system with a manually-controlled clock.
 *
 * Acceptance criteria for TASK-65:
 *   - General 20 msg/s, burst 40.
 *   - Chat 1 msg per 2 s, max length 280, 10 / 30 s sliding window.
 *   - 3 violations in 10 s → drop with code 4009, reason `flooded`.
 *   - Drop behavior + chat-window logic + token-bucket math covered
 *     by `./ratelimit.test.ts` and `./ws.ratelimit.test.ts`.
 */

// ---------------------------------------------------------------------------
// Constants — exported so callers can reference them without hard-coding
// ---------------------------------------------------------------------------

/** Sustained message rate (tokens per second) per WS connection. */
export const GENERAL_RATE_LIMIT = 20;

/** Bucket capacity (and burst allowance) per WS connection. */
export const GENERAL_BURST = 40;

/** Sliding-window length used by `FloodTracker` to count violations. */
export const FLOOD_WINDOW_MS = 10_000;

/** Number of rate-limit violations within `FLOOD_WINDOW_MS` that triggers
 * a hard drop. */
export const FLOOD_VIOLATION_THRESHOLD = 3;

/** Minimum interval (ms) between two consecutive chat messages. */
export const CHAT_MIN_GAP_MS = 2_000;

/** Sliding-window length used by `ChatLimiter` to count chat messages. */
export const CHAT_WINDOW_MS = 30_000;

/** Maximum number of chat messages allowed within `CHAT_WINDOW_MS`. */
export const CHAT_WINDOW_MAX = 10;

/** Maximum characters in a single chat message. */
export const CHAT_MAX_LEN = 280;

/** WS close code used when a connection is dropped for flooding.
 * Application-defined range (4000-4999); 4009 picked to match the spec. */
export const FLOOD_CLOSE_CODE = 4009;

/** Close reason sent along with `FLOOD_CLOSE_CODE`. */
export const FLOOD_CLOSE_REASON = "flooded";

// ---------------------------------------------------------------------------
// ChatLimiter — chat-specific accept/reject
// ---------------------------------------------------------------------------

/** Outcome of `ChatLimiter.check()`. */
export type ChatCheckResult =
  | { accepted: true; reason: null }
  | { accepted: false; reason: "too-long" | "too-soon" | "too-many" };

/**
 * Combined chat-specific rate limiter. Three independent checks, evaluated
 * in this order:
 *   1. Length: `textLen > CHAT_MAX_LEN` → reject `too-long`.
 *   2. Min-gap: time since the last accepted chat < `CHAT_MIN_GAP_MS`
 *      → reject `too-soon`.
 *   3. Window: messages in the last `CHAT_WINDOW_MS` ≥ `CHAT_WINDOW_MAX`
 *      → reject `too-many`.
 *
 * On accept the limiter records the timestamp so future checks see this
 * one. Violations do NOT record state — they're checked but not
 * persisted (because the result is "rejected", and we're not going to
 * broadcast the message).
 */
export class ChatLimiter {
  private lastSendAt: number | null = null;
  private readonly sendTimestamps: number[] = [];

  constructor(
    private readonly minGapMs: number,
    private readonly windowMs: number,
    private readonly windowMax: number,
    private readonly maxLen: number,
    private readonly nowFn: () => number,
  ) {
    if (minGapMs <= 0 || windowMs <= 0 || windowMax <= 0 || maxLen <= 0) {
      throw new Error("ChatLimiter requires positive timing and size bounds");
    }
  }

  /**
   * Decide whether a chat message of length `textLen` is allowed at
   * time `now` (defaulting to the injected clock). Returns the result
   * record; the dispatch route turns a rejection into a `rate-limited`
   * error frame.
   */
  check(textLen: number, now?: number): ChatCheckResult {
    const t = this.resolveNow(now);

    if (textLen > this.maxLen) {
      return { accepted: false, reason: "too-long" };
    }

    // First send gets a free pass on the gap (no previous send).
    if (this.lastSendAt !== null && t - this.lastSendAt < this.minGapMs) {
      return { accepted: false, reason: "too-soon" };
    }

    const cutoff = t - this.windowMs;
    while (this.sendTimestamps.length > 0 && this.sendTimestamps[0]! < cutoff) {
      this.sendTimestamps.shift();
    }
    if (this.sendTimestamps.length >= this.windowMax) {
      return { accepted: false, reason: "too-many" };
    }

    this.lastSendAt = t;
    this.sendTimestamps.push(t);
    return { accepted: true, reason: null };
  }

  /** Test-only: current sliding-window count. */
  sizeForTesting(now?: number): number {
    const t = this.resolveNow(now);
    const cutoff = t - this.windowMs;
    let n = 0;
    for (const ts of this.sendTimestamps) {
      if (ts >= cutoff) n += 1;
    }
    return n;
  }

  private resolveNow(now: number | undefined): number {
    return typeof now === "number" ? now : this.nowFn();
  }
}

// ---------------------------------------------------------------------------
// TokenBucket — lazy-refill generic rate limiter
// ---------------------------------------------------------------------------

/**
 * Generic lazy-refill token bucket. `rate` tokens accrue per second,
 * capped at `burst`. `take()` spends one token if available; otherwise
 * it returns `false` and the caller treats the message as rate-limited.
 *
 * Lazy refill means tokens are recomputed only on each `take()` call,
 * not via a background timer, so an idle bucket has no scheduler
 * overhead. The bucket holds a closure over the injected clock so the
 * refill is reproducible in tests.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly nowFn: () => number,
  ) {
    if (rate <= 0 || burst <= 0) {
      throw new Error("TokenBucket requires positive rate and burst");
    }
    this.tokens = burst;
    this.lastRefillAt = nowFn();
  }

  /**
   * Spend one token at time `now` (defaulting to the injected clock).
   * Returns `true` if a token was available (and consumed), `false`
   * otherwise. The bucket is mutated in-place so successive `take()`
   * calls see the same source of truth.
   */
  take(now?: number): boolean {
    const t = this.resolveNow(now);
    if (t > this.lastRefillAt) {
      const elapsedMs = t - this.lastRefillAt;
      const earned = (elapsedMs / 1000) * this.rate;
      this.tokens = Math.min(this.burst, this.tokens + earned);
      this.lastRefillAt = t;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Test-only: current token count after the most recent refill. */
  get tokensForTesting(): number {
    return this.tokens;
  }

  private resolveNow(now: number | undefined): number {
    return typeof now === "number" ? now : this.nowFn();
  }
}

// ---------------------------------------------------------------------------
// FloodTracker — sliding-window violation counter for escalation
// ---------------------------------------------------------------------------

/**
 * Sliding-window counter for rate-limit violations. `noteViolation(now)`
 * records a violation timestamp; `shouldDrop(now)` is true once
 * `FLOOD_VIOLATION_THRESHOLD` violations are present in the last
 * `FLOOD_WINDOW_MS`. The escalation is one-shot: after a drop is
 * signalled the tracker should be discarded along with its connection.
 *
 * Storage is a simple timestamp array — small (max 3 entries under the
 * spec) and shifted in O(n) per eviction. A deque would be asymptotically
 * nicer but unnecessary for `n ≤ 3`.
 */
export class FloodTracker {
  private readonly violations: number[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly threshold: number,
    private readonly nowFn: () => number,
  ) {
    if (windowMs <= 0 || threshold <= 0) {
      throw new Error("FloodTracker requires positive window and threshold");
    }
  }

  /**
   * Record a violation. Returns `true` if this push was the one that
   * crossed the threshold (i.e. the connection should be dropped now);
   * `false` otherwise. The dispatcher treats a `true` return as a
   * signal to terminate the socket.
   */
  noteViolation(now?: number): boolean {
    const t = this.resolveNow(now);
    this.violations.push(t);
    const cutoff = t - this.windowMs;
    while (this.violations.length > 0 && this.violations[0]! < cutoff) {
      this.violations.shift();
    }
    return this.violations.length >= this.threshold;
  }

  /** Test-only: current count of violations within the window. */
  sizeForTesting(now?: number): number {
    const t = this.resolveNow(now);
    const cutoff = t - this.windowMs;
    let n = 0;
    for (const v of this.violations) {
      if (v >= cutoff) n += 1;
    }
    return n;
  }

  private resolveNow(now: number | undefined): number {
    return typeof now === "number" ? now : this.nowFn();
  }
}

// ---------------------------------------------------------------------------
// Human-readable violation messages for the chat limiter
// ---------------------------------------------------------------------------

/**
 * Map a chat-limiter rejection reason to a short message suitable for
 * the `error.message` field. Kept here so the dispatch code stays free
 * of `string` literals and so a future translation layer can hook a
 * single chokepoint.
 */
export function chatLimitMessage(
  reason: Exclude<ChatCheckResult, { accepted: true }>["reason"],
): string {
  switch (reason) {
    case "too-long":
      return `Chat message exceeds ${CHAT_MAX_LEN} characters`;
    case "too-soon":
      return `Chat rate too high (min 1 message per ${CHAT_MIN_GAP_MS} ms)`;
    case "too-many":
      return `Chat rate too high (max ${CHAT_WINDOW_MAX} messages per ${CHAT_WINDOW_MS} ms)`;
  }
}
