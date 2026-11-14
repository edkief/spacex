import { describe, expect, it } from 'vitest';
import {
  ChatLimiter,
  ConnectionLimiter,
  SlidingWindowLimiter,
  TokenBucket,
  ViolationTracker,
  createConnectionLimits,
} from './ratelimit.ts';
import { LIMITS } from './limits.ts';
import { FakeTimers } from './testing/fakeTimers.ts';

describe('TokenBucket', () => {
  it('accepts up to the burst, then rejects (accept/accept/reject)', () => {
    const t = new FakeTimers();
    const bucket = new TokenBucket(1, 2, t.now);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
  });

  it('refills at the configured rate, fractionally', () => {
    const t = new FakeTimers();
    const bucket = new TokenBucket(10, 3, t.now); // 10 tokens/s -> one per 100 ms
    for (let i = 0; i < 3; i++) bucket.take();
    t.advance(99);
    expect(bucket.take()).toBe(false);
    t.advance(1);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    t.advance(250);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('never holds more than the burst, however long it idles', () => {
    const t = new FakeTimers();
    const bucket = new TokenBucket(20, 40, t.now);
    t.advance(3_600_000);
    let accepted = 0;
    while (bucket.take()) accepted++;
    expect(accepted).toBe(40);
  });

  it('ignores a clock that moves backwards and rejects over-sized costs', () => {
    const t = new FakeTimers();
    const bucket = new TokenBucket(10, 5, t.now);
    for (let i = 0; i < 5; i++) bucket.take();
    t.advance(-1000);
    expect(bucket.take()).toBe(false);
    expect(bucket.take(6)).toBe(false);
  });

  it('matches the spec limits: 40 burst then 20 msg/s', () => {
    const t = new FakeTimers();
    const { bucket } = createConnectionLimits(t.now);
    let burst = 0;
    while (bucket.take()) burst++;
    expect(burst).toBe(LIMITS.messageBurst);
    t.advance(50);
    expect(bucket.take()).toBe(true); // 20/s -> 1 token per 50 ms
    expect(bucket.take()).toBe(false);
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows N per window per key and slides', () => {
    const t = new FakeTimers();
    const limiter = new SlidingWindowLimiter(2, 1000, t.now);
    expect(limiter.tryAcquire('a')).toBe(true);
    t.advance(400);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
    expect(limiter.tryAcquire('b')).toBe(true);
    t.advance(599);
    expect(limiter.tryAcquire('a')).toBe(false);
    t.advance(1); // the first hit is now exactly 1000 ms old
    expect(limiter.tryAcquire('a')).toBe(true);
  });

  it('does not count rejected attempts against the window', () => {
    const t = new FakeTimers();
    const limiter = new SlidingWindowLimiter(1, 1000, t.now);
    expect(limiter.tryAcquire('k')).toBe(true);
    for (let i = 0; i < 50; i++) expect(limiter.tryAcquire('k')).toBe(false);
    t.advance(1000);
    expect(limiter.tryAcquire('k')).toBe(true);
  });
});

describe('ChatLimiter', () => {
  it('enforces one message per 2 s', () => {
    const t = new FakeTimers();
    const chat = new ChatLimiter(t.now);
    expect(chat.check()).toEqual({ ok: true });
    t.advance(1999);
    expect(chat.check()).toEqual({ ok: false, reason: 'too-fast' });
    t.advance(1);
    expect(chat.check()).toEqual({ ok: true });
  });

  it('enforces 10 messages per 30 s sliding window', () => {
    const t = new FakeTimers();
    const chat = new ChatLimiter(t.now);
    for (let i = 0; i < 10; i++) {
      expect(chat.check()).toEqual({ ok: true });
      t.advance(2000);
    }
    // 10 sent at t=0,2,...,18 s; now t=20 s: window still holds all 10.
    expect(chat.check()).toEqual({ ok: false, reason: 'window-full' });
    t.advance(9_999); // t=29.999 s: the first message (t=0) is still inside the window
    expect(chat.check()).toEqual({ ok: false, reason: 'window-full' });
    t.advance(1); // t=30 s: first message aged out
    expect(chat.check()).toEqual({ ok: true });
  });

  it('records nothing for rejected messages, so they cannot extend a lockout', () => {
    const t = new FakeTimers();
    const chat = new ChatLimiter(t.now);
    chat.check();
    for (let i = 0; i < 10; i++) {
      t.advance(100);
      expect(chat.check().ok).toBe(false);
    }
    t.advance(1000); // 2.0 s after the one accepted message
    expect(chat.check().ok).toBe(true);
  });
});

describe('ViolationTracker', () => {
  it('escalates on the 3rd violation within 10 s', () => {
    const t = new FakeTimers();
    const v = new ViolationTracker(t.now);
    expect(v.record()).toBe(false);
    t.advance(4000);
    expect(v.record()).toBe(false);
    t.advance(5000);
    expect(v.record()).toBe(true);
  });

  it('forgets violations older than 10 s', () => {
    const t = new FakeTimers();
    const v = new ViolationTracker(t.now);
    v.record();
    v.record();
    t.advance(10_000);
    expect(v.record()).toBe(false);
    expect(v.record()).toBe(false);
    expect(v.record()).toBe(true);
  });
});

describe('ConnectionLimiter', () => {
  it('caps holders per key and frees slots on release', () => {
    const limiter = new ConnectionLimiter(2);
    expect(limiter.acquire('ip')).toBe(true);
    expect(limiter.acquire('ip')).toBe(true);
    expect(limiter.acquire('ip')).toBe(false);
    expect(limiter.acquire('other')).toBe(true);
    limiter.release('ip');
    expect(limiter.acquire('ip')).toBe(true);
    limiter.release('ip');
    limiter.release('ip');
    limiter.release('ip');
    expect(limiter.count('ip')).toBe(0);
  });
});
