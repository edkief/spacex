/**
 * Per-connection rate limiting and chat spam control (TASK-65).
 *
 * TokenBucket      — general inbound gate: 20 msg/s, burst 40 per connection.
 * ChatLimiter      — chat-specific rules: 2 s min gap, 280 chars, 10 msg / 30 s
 *                    sliding window.
 * ViolationTracker — escalation: 3 rate-limit violations within 10 s → drop.
 *
 * All clocks are injected (`now`) so unit tests run on a fake time line.
 */

/** Sustained inbound message rate per connection (tokens per second). */
export const MESSAGE_RATE = 20;
/** Instantaneous burst allowance before the bucket runs dry. */
export const MESSAGE_BURST = 40;

/** Escalation: this many violations inside the window closes the connection. */
export const VIOLATION_LIMIT = 3;
export const VIOLATION_WINDOW_MS = 10_000;

/** Chat rules: minimum gap between sends, max length, sliding window. */
export const CHAT_MIN_GAP_MS = 2_000;
export const CHAT_MAX_CHARS = 280;
export const CHAT_WINDOW_MS = 30_000;
export const CHAT_WINDOW_MAX = 10;

type Now = () => number;

/**
 * Refilling token bucket. `take()` consumes one token; tokens refill
 * continuously at `rate`/second, capped at `burst`.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: Now = Date.now,
  ) {
    this.tokens = burst;
    this.lastRefill = now();
  }

  /** Try to consume one token. Refills from the injected clock first. */
  take(): boolean {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.rate);
      this.lastRefill = t;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Sliding-window violation counter. `record()` stamps the current time and
 * reports true once the violation count inside the window reaches `limit`.
 */
export class ViolationTracker {
  private times: number[] = [];

  constructor(
    private readonly windowMs: number = VIOLATION_WINDOW_MS,
    private readonly limit: number = VIOLATION_LIMIT,
    private readonly now: Now = Date.now,
  ) {}

  /** Record one violation; true when escalation (drop) is warranted. */
  record(): boolean {
    const t = this.now();
    this.times.push(t);
    while (this.times.length > 0 && this.times[0] <= t - this.windowMs) {
      this.times.shift();
    }
    return this.times.length >= this.limit;
  }
}

export type ChatVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Per-connection chat limiter. `check()` enforces the min gap and the sliding
 * window; it only advances state when the message is accepted, so rejected
 * messages never consume window slots or reset the gap timer.
 */
export class ChatLimiter {
  private lastSendAt = Number.NEGATIVE_INFINITY;
  private sends: number[] = [];

  constructor(private readonly now: Now = Date.now) {}

  /** Validate a chat message; on success record it and return {ok: true}. */
  check(text: string): ChatVerdict {
    const t = this.now();
    if (text.length > CHAT_MAX_CHARS) {
      return { ok: false, reason: `chat message exceeds ${CHAT_MAX_CHARS} characters` };
    }
    if (t - this.lastSendAt < CHAT_MIN_GAP_MS) {
      return { ok: false, reason: `chat messages must be at least ${CHAT_MIN_GAP_MS} ms apart` };
    }
    while (this.sends.length > 0 && this.sends[0] <= t - CHAT_WINDOW_MS) {
      this.sends.shift();
    }
    if (this.sends.length >= CHAT_WINDOW_MAX) {
      return {
        ok: false,
        reason: `chat rate limit: at most ${CHAT_WINDOW_MAX} messages per ${CHAT_WINDOW_MS / 1000} s`,
      };
    }
    this.lastSendAt = t;
    this.sends.push(t);
    return { ok: true };
  }
}
