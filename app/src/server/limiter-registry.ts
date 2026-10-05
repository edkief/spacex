/**
 * TASK-67: the limiter registry — every stateful (game-state-mutating)
 * handler mapped to the EXPLICIT limiter that gates it. This module is a
 * documentation/audit surface only (it changes no behavior): the coverage
 * test (tests/abuse/audit.spec.ts) asserts the registry covers the whole
 * handler list, and the abuse suite (tests/abuse/abuse.spec.ts) proves each
 * limiter actually neutralizes its cheat class against a scripted client.
 *
 * Every handler is ALSO behind the general inbound token bucket
 * (MESSAGE_RATE / MESSAGE_BURST per connection) — the registry records the
 * handler-SPECIFIC limiter, which is the one a cheat scenario targets.
 */
import { CHAT_MAX_CHARS, CHAT_WINDOW_MAX, CHAT_WINDOW_MS } from '@shared/chat';
import { MAX_PLAYERS_PER_SYSTEM, PROTOCOL_VERSION } from '@shared/protocol';
import { MINING_UNIT_MS } from '@shared/mining';
import { FIRE_SPAM_LIMIT, WEAPON_LOCK_MS } from '@server/shard/shard';
import {
  MESSAGE_BURST,
  MESSAGE_RATE,
  VIOLATION_LIMIT,
  VIOLATION_WINDOW_MS,
} from '@server/ratelimit';

/** The stateful handlers that may mutate game state (the audit's list). */
export const STATEFUL_HANDLERS = [
  'fire',
  'mine',
  'sell',
  'interact',
  'chat',
  'warp',
  'join',
] as const;
export type StatefulHandler = (typeof STATEFUL_HANDLERS)[number];

/** The limiter mechanisms actually implemented in the server. */
export const LIMITER_KINDS = [
  'inbound-token-bucket', // MESSAGE_RATE/BUCKET per connection (all inbound)
  'chat-window', // ChatLimiter: chars + sliding window + violation escalation
  'spam-lock', // FIRE_SPAM_LIMIT fires/s → WEAPON_LOCK_MS lockout
  'weapon-cooldown', // per-weapon fireRate enforced by the sim (single writer)
  'server-cadence', // award only on the server clock (mining channel)
  'occupancy-cap', // MAX_PLAYERS_PER_SYSTEM per shard
  'serialization', // per-connection async queue: exactly one warp in flight
] as const;
export type LimiterKind = (typeof LIMITER_KINDS)[number];

export interface LimiterEntry {
  handler: StatefulHandler;
  /** The handler-specific limiter (on top of the general inbound bucket). */
  kind: LimiterKind;
  /** Human-readable bound, read off the real constants. */
  bound: string;
}

/**
 * The registry: handler → explicit limiter. `bound` strings are derived from
 * the same constants the production code enforces (imported, not re-typed),
 * so a drift between this table and the implementation is a review flag, not
 * a silent change.
 */
export const LIMITER_REGISTRY: Readonly<Record<StatefulHandler, LimiterEntry>> = {
  fire: {
    handler: 'fire',
    kind: 'spam-lock',
    bound:
      `${FIRE_SPAM_LIMIT} fire-intents/s per connection → ${WEAPON_LOCK_MS} ms lockout; ` +
      `per-weapon fireRate cooldown (sim, single writer) + energy cost; ` +
      `every intent also passes the ${MESSAGE_RATE} msg/s inbound bucket`,
  },
  mine: {
    handler: 'mine',
    kind: 'server-cadence',
    bound:
      `a unit is awarded only on the server's ${MINING_UNIT_MS} ms channel tick; ` +
      `mine-start/tick/stop messages are idempotent state, never awards; ` +
      `the ${MESSAGE_RATE} msg/s inbound bucket bounds the spam itself`,
  },
  sell: {
    handler: 'sell',
    kind: 'inbound-token-bucket',
    bound:
      `${MESSAGE_RATE} msg/s, burst ${MESSAGE_BURST} per connection; ` +
      `the handler re-validates funding from live state, so a sell can never ` +
      `credit more than the source stack holds (repeated sells are capped, not duplicated)`,
  },
  interact: {
    handler: 'interact',
    kind: 'inbound-token-bucket',
    bound:
      `${MESSAGE_RATE} msg/s, burst ${MESSAGE_BURST} per connection; ` +
      `per-kind range + ownership + regime validation in the shard ` +
      `(${VIOLATION_LIMIT} rate-limit violations in ${VIOLATION_WINDOW_MS} ms → 4009 kick)`,
  },
  chat: {
    handler: 'chat',
    kind: 'chat-window',
    bound:
      `ChatLimiter: ${CHAT_MAX_CHARS} chars, ${CHAT_WINDOW_MAX} messages per ` +
      `${CHAT_WINDOW_MS} ms sliding window per connection; violations escalate ` +
      `(${VIOLATION_LIMIT} in ${VIOLATION_WINDOW_MS} ms → 4009 kick)`,
  },
  warp: {
    handler: 'warp',
    kind: 'serialization',
    bound:
      `per-connection async queue: exactly ONE warp in flight, later requests ` +
      `are serialized and re-validated (target == current system → rejected); ` +
      `target validated against the registry + the ${MAX_PLAYERS_PER_SYSTEM} player cap`,
  },
  join: {
    handler: 'join',
    kind: 'occupancy-cap',
    bound:
      `at most ${MAX_PLAYERS_PER_SYSTEM} connected players per shard ` +
      `(join_system into a full shard → system-full, the player stays put); ` +
      `protocol v${PROTOCOL_VERSION} handshake gate before any join`,
  },
};
