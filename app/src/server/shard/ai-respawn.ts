/**
 * Rogue-AI respawn lifecycle — TASK-45 keystone.
 *
 * AI ships are persistent per-system entities, but the spec
 * treats them as a "renewable threat" — when a player destroys
 * one, it respawns at its `aiSpawnPos` after a 120 s cooldown.
 * This module owns the respawn lifecycle:
 *
 *   - `scheduleAiRespawn(shard, args)` — drops the live AI
 *     entity (the player gets the `combat_event { destroyed }`
 *     but no wreck — rogues go poof) and registers a
 *     `ShardAiRespawn` keyed by `aiId`.
 *   - `advanceAiRespawns(shard, nowMs)` — called once per tick
 *     by `SimLoop`. Walks the registry, re-mints any entry
 *     whose `respawnAtMs` has elapsed, logs a `"rogue respawn"`
 *     line, and removes the entry so the map stays bounded.
 *
 * The helper also exposes `cancelAiRespawn(shard, aiId)` for the
 * reap-shard path — the router calls it on every connection
 * shutdown so an in-flight respawn doesn't leak into the next
 * shard re-spawn. The helper is keyed off the `aiId` so a rogue
 * that survived two cycles only has one outstanding entry at a
 * time.
 *
 * @see ../shared/world/ai.ts for the seed-derived roster.
 * @see ../shared/world/ai.ts#AI_RESPAWN_DELAY_MS for the 120 s spec value.
 */
import { AI_RESPAWN_DELAY_MS } from "@shared/world/ai.js";
import type { ProtocolShipClassId } from "@shared/protocol/index.js";

import { makeAiEntity } from "./entity.js";
import { broadcastCombatEvent } from "./combat-events.js";
import type { Shard, ShardAiRespawn } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Re-export of the AI respawn delay so server-side callers
 * (`applyCombatDamage` special-case) read the same constant as the
 * shared module exports. Importing from `@shared/world/ai` would
 * create a cross-tier dep graph; the local re-export keeps the
 * server's import surface flat.
 */
export const RESPAWN_DELAY_MS = AI_RESPAWN_DELAY_MS;

/**
 * Tag prefix for the debug log line the router emits on every
 * successful respawn. The spec calls for `'rogue respawn'`; the
 * logger uses this so the Playwright harness can grep for it
 * without locking on the localised text.
 */
const RESPAWN_LOG_TAG = "[drift-rogue]";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Schedule a rogue respawn. Strips the live AI entity from the
 * registry (no wreck — rogues go poof), broadcasts the canonical
 * `combat_event { kind: 'destroyed' }`, and registers the timer
 * keyed by the rogue's aiId.
 *
 * Idempotent on `aiId`: calling this twice for the same rogue
 * within the cooldown window replaces the existing timer entry
 * (the second call's `respawnAtMs` wins). This handles the rare
 * double-destroy race — `applyCombatDamage`'s double-destroy
 * guard already prevents a second `destroyed` event, but if a
 * future damage source ever overlaps this handler the worst case
 * is a slightly-later respawn, not a ghost entity.
 *
 * Returns the registered timer entry so callers (tests) can
 * inspect it.
 */
export function scheduleAiRespawn(
  shard: Shard,
  args: {
    aiId: string;
    spawnPos: { x: number; y: number; z: number };
    classId: ProtocolShipClassId;
    callsign: string;
    /**
     * Wall-clock ms timestamp the respawn should fire at.
     * Defaults to `now + AI_RESPAWN_DELAY_MS` so the typical
     * call site stays terse. Tests inject a fake-clock value.
     */
    respawnAtMs?: number;
    /** Optional logger (defaults to `console`). */
    logger?: Pick<Console, "debug" | "warn">;
  },
): ShardAiRespawn {
  const now = Date.now();
  const respawnAtMs = args.respawnAtMs ?? now + RESPAWN_DELAY_MS;
  // Drop the live entity first so a `combat_event` replay from a
  // hostile client doesn't see the destroyed rogue still in the
  // registry. Inline delete so this module doesn't take a
  // circular dependency on `./index.js` (which re-exports
  // `removeEntity` from this file's neighbourhood).
  shard.entities.delete(args.aiId);
  broadcastCombatEvent(shard, {
    kind: "destroyed",
    target: args.aiId,
    source: { kind: "ai", id: args.callsign },
    tick: shard.sim.currentTick,
  });
  const entry: ShardAiRespawn = {
    aiId: args.aiId,
    spawnPos: { ...args.spawnPos },
    classId: args.classId,
    callsign: args.callsign,
    respawnAtMs,
  };
  shard.aiRespawns.set(args.aiId, entry);
  return entry;
}

/**
 * Walk the respawn registry and re-mint any entry whose timer
 * has elapsed. Called by `SimLoop.runOneStep` once per tick.
 *
 * Returns the list of aiIds that were respawned so the caller
 * can wire follow-on effects (e.g. broadcast a chat ping —
 * v1 just logs to the shard event bus).
 */
export function advanceAiRespawns(
  shard: Shard,
  args: { nowMs?: number; logger?: Pick<Console, "debug" | "warn"> } = {},
): string[] {
  const now = args.nowMs ?? Date.now();
  const respawned: string[] = [];
  // Snapshot the keys so we can mutate the map during iteration.
  const ids = Array.from(shard.aiRespawns.keys());
  for (const aiId of ids) {
    const entry = shard.aiRespawns.get(aiId);
    if (!entry) continue;
    if (entry.respawnAtMs > now) continue;
    // Re-mint the entity. The AI entity has the same aiId so a
    // client lock on it resumes cleanly on the next snapshot.
    const entity = makeAiEntity({
      id: entry.aiId,
      classId: entry.classId,
      pos: entry.spawnPos,
      callsign: entry.callsign,
      aiSpawnPos: entry.spawnPos,
      aiPatrolCenter: entry.spawnPos,
      aiPatrolRadius: 0, // TASK-46 will refill from the seeded roster
    });
    shard.entities.set(entity.id, entity);
    respawned.push(aiId);
    args.logger?.debug?.(
      `${RESPAWN_LOG_TAG} rogue respawn ${entry.callsign} (${entry.aiId}) at ${entry.respawnAtMs} ms`,
    );
    // Drop the entry first so a re-entrant kill within the same
    // tick is recorded against the freshly-minted entity (the
    // `applyCombatDamage` look-up will find it).
    shard.aiRespawns.delete(aiId);
  }
  return respawned;
}

/**
 * Cancel a pending respawn. Called by the reap path so an
 * entry left over from the previous shard lifetime doesn't
 * leak into the next re-spawn. Idempotent on `aiId` — a miss is
 * a silent no-op.
 */
export function cancelAiRespawn(shard: Shard, aiId: string): boolean {
  return shard.aiRespawns.delete(aiId);
}

/**
 * Drop every outstanding respawn. Used by `shard.shutdown` so
 * a reaped shard doesn't carry timers across a re-spawn. Returns
 * the count of entries that were cleared.
 */
export function clearAiRespawns(shard: Shard): number {
  const size = shard.aiRespawns.size;
  shard.aiRespawns.clear();
  return size;
}
