/** Rate and connection limits, in one place. */
export const LIMITS = {
  /** General message rate per connection (token bucket refill per second). */
  messagesPerSecond: 20,
  /** Bucket capacity: the burst a connection may send at once. */
  messageBurst: 40,
  /** Rate-limit violations within `violationWindowMs` that drop the connection. */
  violationLimit: 3,
  violationWindowMs: 10_000,
  /** Chat: minimum gap between messages, and a sliding window cap. */
  chatMinGapMs: 2000,
  chatWindowMax: 10,
  chatWindowMs: 30_000,
  /** Concurrent sockets per client IP and per session token. */
  socketsPerIp: 8,
  socketsPerToken: 4,
  /** Callsign claims per IP per minute. */
  claimsPerMinute: 5,
  claimWindowMs: 60_000,
} as const;

/** Close code used when a connection is dropped for flooding. */
export const FLOODED_CLOSE_REASON = 'flooded';
