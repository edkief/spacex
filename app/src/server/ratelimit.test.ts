import { describe, expect, it } from 'vitest';

import {
  CHAT_MAX_CHARS,
  CHAT_MIN_GAP_MS,
  CHAT_WINDOW_MAX,
  CHAT_WINDOW_MS,
  MESSAGE_BURST,
  MESSAGE_RATE,
  TokenBucket,
  ChatLimiter,
  ViolationTracker,
} from '@server/ratelimit';

class FakeClock {
  t = 0;
  now = (): number => this.t;
  tick(ms: number): void {
    this.t += ms;
  }
}

describe('TokenBucket', () => {
  it('accepts a full burst then rejects until tokens refill (accept/accept/reject)', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(MESSAGE_RATE, MESSAGE_BURST, clock.now);
    for (let i = 0; i < MESSAGE_BURST; i++) {
      expect(bucket.take(), `take #${i + 1}`).toBe(true);
    }
    expect(bucket.take(), 'take beyond burst').toBe(false);
    // Refill is continuous: 20 msg/s → one token every 50 ms.
    clock.tick(49);
    expect(bucket.take()).toBe(false);
    clock.tick(1);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('sustains 10 Hz gameplay input forever without tripping (normal play never limits)', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(MESSAGE_RATE, MESSAGE_BURST, clock.now);
    for (let i = 0; i < 1000; i++) {
      clock.tick(100);
      expect(bucket.take(), `input #${i + 1}`).toBe(true);
    }
  });

  it('caps refilled tokens at the burst allowance', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(MESSAGE_RATE, MESSAGE_BURST, clock.now);
    for (let i = 0; i < MESSAGE_BURST + 1; i++) bucket.take();
    clock.tick(10_000); // far more than enough for a full refill
    let accepted = 0;
    while (bucket.take()) accepted++;
    expect(accepted).toBe(MESSAGE_BURST);
  });

  it('throttles a 100 msg/s flood down to the sustained 20 msg/s rate', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(MESSAGE_RATE, MESSAGE_BURST, clock.now);
    let accepted = 0;
    for (let i = 0; i < 1000; i++) {
      clock.tick(10); // 100 msg/s
      if (bucket.take()) accepted++;
    }
    // Sustained allowance is 20/s (200 over 10 s) plus leftover burst.
    expect(accepted).toBeGreaterThan(200);
    expect(accepted).toBeLessThan(260);
  });
});

describe('ChatLimiter', () => {
  it('enforces the 2 s minimum gap between sends', () => {
    const clock = new FakeClock();
    const limiter = new ChatLimiter(clock.now);
    expect(limiter.check('first')).toEqual({ ok: true });
    clock.tick(CHAT_MIN_GAP_MS - 1);
    expect(limiter.check('too soon')).toMatchObject({ ok: false });
    clock.tick(1);
    expect(limiter.check('right on time')).toEqual({ ok: true });
  });

  it('rejected messages never consume window slots or reset the gap', () => {
    const clock = new FakeClock();
    const limiter = new ChatLimiter(clock.now);
    expect(limiter.check('a')).toEqual({ ok: true });
    clock.tick(500);
    expect(limiter.check('spam')).toMatchObject({ ok: false });
    clock.tick(500);
    expect(limiter.check('spam again')).toMatchObject({ ok: false });
    // Gap is measured from the accepted message, not the rejected ones.
    clock.tick(1_000);
    expect(limiter.check('accepted at 2 s')).toEqual({ ok: true });
  });

  it('caps at 10 messages per 30 s sliding window', () => {
    const clock = new FakeClock();
    const limiter = new ChatLimiter(clock.now);
    for (let i = 0; i < CHAT_WINDOW_MAX; i++) {
      expect(limiter.check(`msg ${i}`)).toEqual({ ok: true });
      clock.tick(CHAT_MIN_GAP_MS); // keep the gap rule satisfied
    }
    clock.tick(CHAT_MIN_GAP_MS);
    expect(limiter.check('eleventh')).toMatchObject({ ok: false });
    // Advance until the first accepted message slides out of the window.
    clock.tick(CHAT_WINDOW_MS - CHAT_MIN_GAP_MS);
    expect(limiter.check('after window slides')).toEqual({ ok: true });
  });

  it('enforces the 280 character max length', () => {
    const clock = new FakeClock();
    const limiter = new ChatLimiter(clock.now);
    expect(limiter.check('x'.repeat(CHAT_MAX_CHARS))).toEqual({ ok: true });
    clock.tick(CHAT_MIN_GAP_MS);
    expect(limiter.check('x'.repeat(CHAT_MAX_CHARS + 1))).toMatchObject({ ok: false });
  });
});

describe('ViolationTracker (escalation)', () => {
  it('drops on the 3rd violation within the 10 s window', () => {
    const clock = new FakeClock();
    const tracker = new ViolationTracker(10_000, 3, clock.now);
    clock.tick(0);
    expect(tracker.record()).toBe(false);
    clock.tick(5_000);
    expect(tracker.record()).toBe(false);
    clock.tick(4_000); // 3rd within 10 s of the first
    expect(tracker.record()).toBe(true);
  });

  it('lets violations age out of the window', () => {
    const clock = new FakeClock();
    const tracker = new ViolationTracker(10_000, 3, clock.now);
    expect(tracker.record()).toBe(false);
    clock.tick(10_001);
    expect(tracker.record()).toBe(false);
    clock.tick(10_001);
    expect(tracker.record()).toBe(false);
    // No escalation ever: each record is >10 s from the previous two.
  });

  it('treats a violation exactly 10 s old as aged out, and 1 ms later as in-window', () => {
    // Exactly at the boundary: the t=0 violation prunes at t=10_000, leaving 2.
    const aClock = new FakeClock();
    const a = new ViolationTracker(10_000, 3, aClock.now);
    a.record(); // t=0
    aClock.tick(5_000);
    expect(a.record()).toBe(false); // t=5_000
    aClock.tick(5_000);
    expect(a.record()).toBe(false); // t=10_000, t=0 aged out

    // One ms inside: the t=1 violation survives the prune at t=10_000, leaving 3.
    const bClock = new FakeClock();
    const b = new ViolationTracker(10_000, 3, bClock.now);
    bClock.tick(1);
    b.record(); // t=1
    bClock.tick(4_999);
    expect(b.record()).toBe(false); // t=5_000
    bClock.tick(5_000);
    expect(b.record()).toBe(true); // t=10_000, t=1 still in window
  });
});
