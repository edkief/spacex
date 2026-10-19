/**
 * Router reap logic (TASK-11 + TASK-12).
 *
 * Encapsulates the "stop empty shards after a grace period" sweep
 * so the router module can stay focused on lifecycle. The reap
 * helper owns the per-shard flush + sim.stop + presence-broadcast
 * sequence; the router just decides WHEN to call it (every interval
 * for the timed sweep, immediately for force-reap, and at
 * shutdown for the final cleanup).
 *
 * Reap sentinel bookkeeping (when did each shard first hit zero
 * connections?) is co-located with the sweep so the file is the
 * single source of truth for the empty-shard lifecycle.
 *
 * @see ./router.ts for the consumer.
 */
import type { EventEmitter } from "node:events";

import { clearAiRespawns } from "../shard/ai-respawn.js";
import type { Shard } from "../shard/types.js";
import type { ShardFlushService } from "../shard/persist.js";
import type { PresenceBroadcaster } from "./presence.js";

/** Per-shard sentinel tracking when the shard first hit zero connections. */
export interface ReapSentinel {
  /** Wall-clock ms when the shard first hit zero connections. */
  emptySinceMs: number;
}

/** Logger shape used by the reap path. */
export type ReapLogger = Pick<Console, "error">;

/** Result of a reap sweep. */
export interface ReapResult {
  /** System ids that were reaped during this sweep. */
  reaped: string[];
}

/**
 * Sweep every shard that has been empty for at least `graceMs`.
 * Each reaped shard gets one final `flushShips` (TASK-24) before
 * its sim loop is stopped.
 *
 * Returns the list of system ids that were reaped so the caller
 * can emit log lines / event-bus notifications.
 *
 * The presence broadcaster is invoked once per reaped shard with an
 * empty roster so any subscriber watching the bus can drop stale
 * references. The router's `shardGeneration` map is NOT cleared —
 * it survives reaps so the reconnect-storm test can verify "no
 * reload happened" across re-spawns.
 */
export async function reapEmpty(args: {
  reapSentinels: Map<string, ReapSentinel>;
  shards: Map<string, Shard>;
  shardStartedAt: Map<string, number>;
  flusher: ShardFlushService;
  presenceBroadcaster: PresenceBroadcaster | undefined;
  events: EventEmitter;
  logger: ReapLogger;
  reapGraceMs: number;
  now: () => number;
  force?: boolean;
}): Promise<ReapResult> {
  const reaped: string[] = [];
  const cutoffMs = args.now() - args.reapGraceMs;
  for (const [systemId, sentinel] of args.reapSentinels.entries()) {
    const shard = args.shards.get(systemId);
    if (!shard) {
      args.reapSentinels.delete(systemId);
      continue;
    }
    if (!args.force && sentinel.emptySinceMs > cutoffMs) {
      continue; // grace hasn't elapsed yet
    }
    // Final flush first so ship positions survive any kill -9 that
    // races with the sim.stop() below.
    try {
      await args.flusher.flushNow(shard);
    } catch (err) {
      args.logger.error?.(`[drift-router] flush of ${systemId} failed during reap:`, err);
    }
    // Stop the sim loop + clear the registry.
    shard.shutdown();
    args.shards.delete(systemId);
    args.shardStartedAt.delete(systemId);
    args.reapSentinels.delete(systemId);
    // TASK-12: presence broadcast a final empty roster so any
    // listener watching the bus can drop stale references. We do
    // this AFTER the registry is cleared so a re-spawn within the
    // same microtask can't race the broadcast.
    if (args.presenceBroadcaster) {
      args.presenceBroadcaster(systemId, { systemId, players: [] });
    }
    // TASK-45: clear pending rogue-AI respawn timers so a reaped
    // shard doesn't leak entries into the next lifetime. The
    // next spawn re-derives the same roster (same seed → same
    // list) so a cleared entry will be re-registered on the
    // first respawn that fires.
    clearAiRespawns(shard);
    reaped.push(systemId);
    args.events.emit("reap", { systemId });
  }
  return { reaped };
}
