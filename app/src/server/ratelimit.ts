export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly nowFn: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.lastRefill = this.nowFn();
  }

  /**
   * Attempts to consume a token from the bucket.
   * Returns true if a token was consumed, false otherwise.
   */
  take(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  private refill(): void {
    const now = this.nowFn();
    const deltaMs = now - this.lastRefill;

    // tokens per millisecond = rate / 1000
    const tokensToAdd = deltaMs * (this.rate / 1000);

    this.tokens = Math.min(this.burst, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Current token count (for debugging/tests)
   */
  get currentTokens(): number {
    this.refill();
    return this.tokens;
  }
}

export class ChatLimiter {
  private lastSendAt: number = 0;
  private window: number[] = [];

  constructor(
    private readonly minGapMs: number = 2000,
    private readonly windowSizeMs: number = 30000,
    private readonly windowMax: number = 10,
    private readonly maxLength: number = 280,
    private readonly nowFn: () => number = () => Date.now(),
  ) {}

  /**
   * Checks if a chat message is allowed.
   * Returns { allowed: boolean, reason?: string }
   */
  check(message: string): { allowed: boolean; reason?: string } {
    const now = this.nowFn();

    if (message.length > this.maxLength) {
      return { allowed: false, reason: 'Message too long' };
    }

    if (now - this.lastSendAt < this.minGapMs) {
      return { allowed: false, reason: 'Sending too fast' };
    }

    // Clean window
    this.window = this.window.filter((ts) => now - ts <= this.windowSizeMs);

    if (this.window.length >= this.windowMax) {
      return { allowed: false, reason: 'Chat limit exceeded' };
    }

    return { allowed: true };
  }

  /**
   * Records a successful chat send.
   */
  recordSend(): void {
    const now = this.nowFn();
    this.lastSendAt = now;
    this.window.push(now);
  }
}
