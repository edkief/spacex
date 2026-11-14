import { LIMITS } from './limits.ts';

type Clock = () => number;

/**
 * Token bucket: holds up to `burst` tokens, refilled at `ratePerSecond`. `take()` spends one
 * token if available. Time comes from the injected clock (epoch/monotonic milliseconds).
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly ratePerSecond: number;
  private readonly burst: number;
  private readonly now: Clock;

  constructor(ratePerSecond: number, burst: number, now: Clock) {
    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.last = now();
  }

  /** Spends `cost` tokens; false (and no change) when there are not enough. */
  take(cost = 1): boolean {
    const t = this.now();
    if (t > this.last) {
      this.tokens = Math.min(
        this.burst,
        this.tokens + ((t - this.last) * this.ratePerSecond) / 1000,
      );
    }
    this.last = Math.max(this.last, t);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** At most `limit` acquisitions per key within any `windowMs` (a true sliding window). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: Clock;

  constructor(limit: number, windowMs: number, now: Clock) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Records a hit and returns true if it is within the limit; rejected hits are not recorded. */
  tryAcquire(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune(t);
    return true;
  }

  /** Drops keys whose hits have all expired, bounding memory. */
  private prune(t: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => t - at >= this.windowMs)) this.hits.delete(key);
    }
  }
}

export type ChatVerdict = { ok: true } | { ok: false; reason: 'too-fast' | 'window-full' };

/** Chat spam control: a minimum gap between messages plus a sliding window cap. */
export class ChatLimiter {
  private readonly window: SlidingWindowLimiter;
  private lastSendAt: number | undefined;
  private readonly now: Clock;
  private readonly minGapMs: number;

  constructor(
    now: Clock,
    minGapMs = LIMITS.chatMinGapMs,
    max = LIMITS.chatWindowMax,
    windowMs = LIMITS.chatWindowMs,
  ) {
    this.now = now;
    this.minGapMs = minGapMs;
    this.window = new SlidingWindowLimiter(max, windowMs, now);
  }

  /** Checks and, when allowed, records a chat message. Rejections record nothing. */
  check(): ChatVerdict {
    const t = this.now();
    if (this.lastSendAt !== undefined && t - this.lastSendAt < this.minGapMs) {
      return { ok: false, reason: 'too-fast' };
    }
    if (!this.window.tryAcquire('chat')) return { ok: false, reason: 'window-full' };
    this.lastSendAt = t;
    return { ok: true };
  }
}

/** Counts events inside a sliding window and reports when the escalation limit is reached. */
export class ViolationTracker {
  private times: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: Clock;

  constructor(now: Clock, limit = LIMITS.violationLimit, windowMs = LIMITS.violationWindowMs) {
    this.now = now;
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Records a violation; true once `limit` violations fall within the window. */
  record(): boolean {
    const t = this.now();
    this.times = this.times.filter((at) => t - at < this.windowMs);
    this.times.push(t);
    return this.times.length >= this.limit;
  }
}

/** Caps concurrent holders per key (client IP, session token). */
export class ConnectionLimiter {
  private readonly counts = new Map<string, number>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** Takes a slot for `key`; false when the key is at its limit. */
  acquire(key: string): boolean {
    const count = this.counts.get(key) ?? 0;
    if (count >= this.max) return false;
    this.counts.set(key, count + 1);
    return true;
  }

  /** Frees a slot previously taken with `acquire`. */
  release(key: string): void {
    const count = this.counts.get(key) ?? 0;
    if (count <= 1) this.counts.delete(key);
    else this.counts.set(key, count - 1);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

/** The per-connection limiters. */
export interface ConnectionLimits {
  bucket: TokenBucket;
  violations: ViolationTracker;
  chat: ChatLimiter;
}

/** Creates a connection's limiters from the standard limits. */
export function createConnectionLimits(now: Clock): ConnectionLimits {
  return {
    bucket: new TokenBucket(LIMITS.messagesPerSecond, LIMITS.messageBurst, now),
    violations: new ViolationTracker(now),
    chat: new ChatLimiter(now),
  };
}
