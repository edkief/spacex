/**
 * Shared galaxy/server constants (TASK-11).
 *
 * Centralising these here keeps the server router, the persistence
 * layer, and the client UI pulling from one source of truth. Anything
 * that affects gameplay or chart capacity belongs in here, not in a
 * server-only module.
 *
 * NOTE on naming convention: the existing shared modules re-export
 * mostly *functions* and *types*. Constants are added one-by-one as
 * new tasks introduce them. `MAX_PLAYERS_PER_SYSTEM` is the first
 * hard-number we need that's gameplay-relevant and runs across both
 * halves of the stack (the chart UI consumes it for occupancy dots,
 * the server router uses it for cap enforcement).
 */

/**
 * Maximum number of concurrent player connections per system shard.
 *
 * Spec calls for a 16-player cap (`MAX_PLAYERS_PER_SYSTEM = 16` in
 * `src/shared`). The router enforces this on `join_system`; the
 * chart UI (TASK-7) reads it for occupancy dots.
 */
export const MAX_PLAYERS_PER_SYSTEM = 16;

/**
 * How long the router waits after a shard's last connection drops
 * before stopping its sim loop and flushing state to the DB.
 *
 * Default 60 s per TASK-11 spec. Tunable via env
 * (`SHARD_REAP_GRACE_MS`) so the reap-fake-timer test can shorten
 * it without rewriting tests.
 */
export const DEFAULT_SHARD_REAP_GRACE_MS = 60_000;

/**
 * Default cadence of the router's `reapEmpty()` sweep loop.
 *
 * Set to 5 s (spec) so a freshly-empty shard is detected within at
 * most one grace interval (`60_000 / 5_000 = 12` sweeps). Tunable via
 * `ROUTER_REAP_INTERVAL_MS` for tests.
 */
export const DEFAULT_ROUTER_REAP_INTERVAL_MS = 5_000;
