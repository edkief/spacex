/**
 * Unit tests for the rate limiting primitives (TASK-65).
 *
 * Each class is exercised against a manually-controlled `clock` so
 * timing-based behaviour is deterministic. The companion integration
 * file `ws.ratelimit.test.ts` covers the dispatch + WebSocket
 * end-to-end behaviour.
 *
 * Coverage:
 *   - `TokenBucket` — accept/accept/reject sequence, lazy refill,
 *     burst-cap, advance past burst, validation guards.
 *   - `FloodTracker` — three-violations-in-window triggers `true`,
 *     eviction after the window slides past, threshold guard.
 *   - `ChatLimiter` — first-send gap bypass, length check, min-gap
 *     check, sliding-window eviction, all three rejection reasons.
 *   - `chatLimitMessage` mapping for each rejection reason.
 *
 * Plus a pin for every TASK-65 acceptance constant so a future change
 * is forced to be deliberate.
 */
import { describe, it, expect } from "vitest";

import {
  ChatLimiter,
  FloodTracker,
  TokenBucket,
  chatLimitMessage,
  CHAT_MAX_LEN,
  CHAT_MIN_GAP_MS,
  CHAT_WINDOW_MAX,
  CHAT_WINDOW_MS,
  FLOOD_CLOSE_CODE,
  FLOOD_CLOSE_REASON,
  FLOOD_VIOLATION_THRESHOLD,
  FLOOD_WINDOW_MS,
  GENERAL_BURST,
  GENERAL_RATE_LIMIT,
} from "./ratelimit.js";

/**
 * Build a manually-advanced clock. `now()` returns the current value,
 * `advance(ms)` shifts it forward by `ms`.
 */
function makeClock(start = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// TokenBucket — accept/accept/reject sequence (TASK-65 acceptance)
// ---------------------------------------------------------------------------

describe("TokenBucket", () => {
  it("accept/accept/reject sequence with a frozen clock", () => {
    const { now } = makeClock();
    const bucket = new TokenBucket(1, 2, now);
    // burst is 2 — first two take() calls succeed, third fails.
    expect(bucket.take(now())).toBe(true);
    expect(bucket.tokensForTesting).toBeGreaterThanOrEqual(0);
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(false);
  });

  it("lazy-refills tokens when time advances", () => {
    const { now, advance } = makeClock();
    // rate = 2 tokens/s, burst = 2.
    const bucket = new TokenBucket(2, 2, now);
    // Drain the burst.
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(false);
    // Advance 500 ms → 1 token earned (2 * 0.5).
    advance(500);
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(false);
  });

  it("caps refills at the burst ceiling", () => {
    const { now, advance } = makeClock();
    const bucket = new TokenBucket(1, 3, now);
    // Drain: 3 true, then 1 false.
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(false);
    // Advance a long time — tokens should refill to the burst cap (3),
    // not accumulate arbitrarily.
    advance(60_000);
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(true);
    expect(bucket.take(now())).toBe(false);
  });

  it("accepts an explicit now override that differs from the clock", () => {
    const { now } = makeClock(0);
    // rate = 1 / s, burst = 5 — round numbers for predictable math.
    const bucket = new TokenBucket(1, 5, now);
    // Drain the burst at t=0.
    for (let i = 0; i < 5; i++) expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(false);
    // Advance 3 s via override → 3 tokens earned, capped at burst=5.
    expect(bucket.take(3_000)).toBe(true);
    expect(bucket.take(3_000)).toBe(true);
    expect(bucket.take(3_000)).toBe(true);
    // 4th take at the same instant fails (3 spent of the burst cap).
    expect(bucket.take(3_000)).toBe(false);
  });

  it("defaults to the injected clock when no time is passed", () => {
    const { now, advance } = makeClock();
    const bucket = new TokenBucket(10, 5, now);
    // Drain.
    for (let i = 0; i < 5; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    // Advance one second — bucket refills automatically.
    advance(1_000);
    expect(bucket.take()).toBe(true);
  });

  it("rejects non-positive rate or burst at construction", () => {
    const { now } = makeClock();
    expect(() => new TokenBucket(0, 10, now)).toThrow();
    expect(() => new TokenBucket(10, 0, now)).toThrow();
    expect(() => new TokenBucket(-1, 10, now)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// FloodTracker — drop behaviour on 3 violations (TASK-65 acceptance)
// ---------------------------------------------------------------------------

describe("FloodTracker", () => {
  it("returns true the third time a violation is recorded within the window", () => {
    const { now, advance } = makeClock();
    const tracker = new FloodTracker(FLOOD_WINDOW_MS, FLOOD_VIOLATION_THRESHOLD, now);
    expect(tracker.noteViolation(now())).toBe(false);
    advance(1_000);
    expect(tracker.noteViolation(now())).toBe(false);
    advance(1_000);
    // 3rd violation within the window → drop.
    expect(tracker.noteViolation(now())).toBe(true);
  });

  it("evicts violations that fall outside the sliding window", () => {
    const { now, advance } = makeClock();
    const tracker = new FloodTracker(FLOOD_WINDOW_MS, FLOOD_VIOLATION_THRESHOLD, now);
    expect(tracker.noteViolation(now())).toBe(false);
    expect(tracker.noteViolation(now())).toBe(false);
    // Slide the window past the first two violations.
    advance(FLOOD_WINDOW_MS + 1);
    // Window now has 0 entries — a single violation is below threshold.
    expect(tracker.noteViolation(now())).toBe(false);
    advance(1_000);
    expect(tracker.noteViolation(now())).toBe(false);
    // Now we've recorded two within the window; the third would trip.
    advance(1_000);
    expect(tracker.noteViolation(now())).toBe(true);
  });

  it("sizeForTesting reflects only timestamps inside the window", () => {
    const { now, advance } = makeClock();
    const tracker = new FloodTracker(FLOOD_WINDOW_MS, FLOOD_VIOLATION_THRESHOLD, now);
    expect(tracker.sizeForTesting(now())).toBe(0);
    tracker.noteViolation(now());
    expect(tracker.sizeForTesting(now())).toBe(1);
    advance(FLOOD_WINDOW_MS + 1);
    expect(tracker.sizeForTesting(now())).toBe(0);
  });

  it("rejects non-positive window or threshold at construction", () => {
    const { now } = makeClock();
    expect(() => new FloodTracker(0, 3, now)).toThrow();
    expect(() => new FloodTracker(10_000, 0, now)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ChatLimiter — chat window logic with fake timers (TASK-65 acceptance)
// ---------------------------------------------------------------------------

describe("ChatLimiter", () => {
  function newLimiter(c = makeClock()) {
    return new ChatLimiter(CHAT_MIN_GAP_MS, CHAT_WINDOW_MS, CHAT_WINDOW_MAX, CHAT_MAX_LEN, c.now);
  }

  it("accepts the very first message regardless of gap", () => {
    const c = makeClock();
    const limiter = newLimiter(c);
    const result = limiter.check(50, c.now());
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe(null);
  });

  it("rejects a second message that arrives within the 2 s min-gap", () => {
    const c = makeClock();
    const limiter = newLimiter(c);
    expect(limiter.check(50, c.now()).accepted).toBe(true);
    c.advance(1_000);
    const result = limiter.check(50, c.now());
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("too-soon");
    }
  });

  it("accepts a message exactly at the 2 s boundary", () => {
    const c = makeClock();
    const limiter = newLimiter(c);
    expect(limiter.check(50, c.now()).accepted).toBe(true);
    c.advance(CHAT_MIN_GAP_MS); // exactly the boundary
    const result = limiter.check(50, c.now());
    expect(result.accepted).toBe(true);
  });

  it("rejects a message whose text length exceeds 280 characters", () => {
    const c = makeClock();
    const limiter = newLimiter(c);
    const result = limiter.check(281, c.now());
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("too-long");
    }
    // State must NOT advance on a rejection.
    expect(limiter.check(100, c.now()).accepted).toBe(true);
  });

  it("accepts a message of exactly the max length", () => {
    const c = makeClock();
    const limiter = newLimiter(c);
    const result = limiter.check(CHAT_MAX_LEN, c.now());
    expect(result.accepted).toBe(true);
  });

  it("rejects once the sliding window holds 10 messages", () => {
    const c = makeClock();
    const limiter = newLimiter(c);
    // Send 10 messages spaced exactly at the min-gap to stay within
    // the policy; the 11th should trip the window.
    for (let i = 0; i < CHAT_WINDOW_MAX; i++) {
      const sent = limiter.check(50, c.now());
      expect(sent.accepted).toBe(true);
      c.advance(CHAT_MIN_GAP_MS + 1);
    }
    expect(limiter.sizeForTesting(c.now())).toBe(CHAT_WINDOW_MAX);
    const blocked = limiter.check(50, c.now());
    expect(blocked.accepted).toBe(false);
    if (!blocked.accepted) {
      expect(blocked.reason).toBe("too-many");
    }
  });

  it("slides entries out of the window as time advances", () => {
    const c = makeClock();
    const limiter = newLimiter(c);
    for (let i = 0; i < CHAT_WINDOW_MAX; i++) {
      expect(limiter.check(50, c.now()).accepted).toBe(true);
      c.advance(CHAT_MIN_GAP_MS + 1);
    }
    expect(limiter.sizeForTesting(c.now())).toBe(CHAT_WINDOW_MAX);
    // Slide the entire window past the recorded timestamps.
    c.advance(CHAT_WINDOW_MS + 1);
    expect(limiter.sizeForTesting(c.now())).toBe(0);
    // A fresh message must be accepted.
    expect(limiter.check(50, c.now()).accepted).toBe(true);
  });

  it("checks length before gap and window", () => {
    // Verify ordering: a too-long message fails 'too-long' even when the
    // chat limiter would otherwise accept it.
    const c = makeClock();
    const limiter = newLimiter(c);
    const result = limiter.check(CHAT_MAX_LEN + 1, c.now());
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("too-long");
  });

  it("rejects non-positive bounds at construction", () => {
    const { now } = makeClock();
    expect(() => new ChatLimiter(0, 30_000, 10, 280, now)).toThrow();
    expect(() => new ChatLimiter(2_000, 0, 10, 280, now)).toThrow();
    expect(() => new ChatLimiter(2_000, 30_000, 0, 280, now)).toThrow();
    expect(() => new ChatLimiter(2_000, 30_000, 10, 0, now)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// chatLimitMessage — guards against silent message-drift regressions
// ---------------------------------------------------------------------------

describe("chatLimitMessage", () => {
  it("describes each rejection reason with the relevant constant", () => {
    const tooLong = chatLimitMessage("too-long");
    expect(tooLong).toContain(String(CHAT_MAX_LEN));
    const tooSoon = chatLimitMessage("too-soon");
    expect(tooSoon).toContain(String(CHAT_MIN_GAP_MS));
    const tooMany = chatLimitMessage("too-many");
    expect(tooMany).toContain(String(CHAT_WINDOW_MAX));
    expect(tooMany).toContain(String(CHAT_WINDOW_MS));
  });
});

// ---------------------------------------------------------------------------
// Constant pins — keep future drift of the spec numbers deliberate
// ---------------------------------------------------------------------------

describe("ratelimit constants", () => {
  it("matches the TASK-65 acceptance values", () => {
    expect(GENERAL_RATE_LIMIT).toBe(20);
    expect(GENERAL_BURST).toBe(40);
    expect(FLOOD_WINDOW_MS).toBe(10_000);
    expect(FLOOD_VIOLATION_THRESHOLD).toBe(3);
    expect(CHAT_MIN_GAP_MS).toBe(2_000);
    expect(CHAT_WINDOW_MS).toBe(30_000);
    expect(CHAT_WINDOW_MAX).toBe(10);
    expect(CHAT_MAX_LEN).toBe(280);
    expect(FLOOD_CLOSE_CODE).toBe(4009);
    expect(FLOOD_CLOSE_REASON).toBe("flooded");
  });
});
