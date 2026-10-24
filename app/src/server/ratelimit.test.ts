import { describe, it, expect, vi } from 'vitest';
import { TokenBucket } from './ratelimit';

describe('TokenBucket', () => {
  it('should allow initial burst', () => {
    const bucket = new TokenBucket(20, 40);
    for (let i = 0; i < 40; i++) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);
  });

  it('should refill tokens over time', () => {
    let now = 1000;
    const bucket = new TokenBucket(20, 40, () => now);

    // Drain bucket
    for (let i = 0; i < 40; i++) {
      bucket.take();
    }
    expect(bucket.take()).toBe(false);

    // Advance 500ms -> should refill 10 tokens (20 * 0.5)
    now += 500;
    for (let i = 0; i < 10; i++) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);
  });

  it('should not exceed burst capacity', () => {
    let now = 1000;
    const bucket = new TokenBucket(20, 10, () => now);

    // Advance 10 seconds -> should refill up to 10, not 200
    now += 10000;

    for (let i = 0; i < 10; i++) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);
  });

  it('should handle precise timing for 1 token', () => {
    let now = 1000;
    const bucket = new TokenBucket(20, 1, () => now); // Burst 1, but we start with 1. Let's drain it first.
    bucket.take(); // now tokens = 0

    // Advance 50ms -> 20 * 0.05 = 1 token
    now += 50;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });
});
