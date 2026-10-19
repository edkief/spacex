/**
 * Combat broadcast + cleanup helpers — TASK-42 split.
 *
 * Extracted from `combat.ts` so the original module could absorb the
 * `resolveHit` LOS logic without exceeding the AGENTS.md 200-300 LOC
 * cap. Two exported helpers:
 *
 *   - `broadcastCombatEvent(shard, event)` — pushes one
 *     `combat_event` frame to every connection in the shard via the
 *     shard's `send` hook. Failures from a single connection do NOT
 *     stop the broadcast.
 *   - `cleanupExpiredWrecks(shard, nowMs)` — removes any
 *     `kind: 'wreck'` entity whose `wreckExpiresAt` has passed.
 *     Returns the count for ops dashboards + tests.
 *
 * The functions are deliberately tiny (each is a few dozen lines)
 * because the spec around them is mostly behavioural. See
 * `combat.ts` for the orchestration (applyCombatDamage + resolveHit)
 * and `types.ts` for the entity + connection shapes.
 */
import type { ProtocolCombatEvent } from "@shared/protocol/index.js";

import type { Shard } from "./types.js";

// ---------------------------------------------------------------------------
// Wreck cleanup
// ---------------------------------------------------------------------------

/**
 * Remove any `kind: 'wreck'` entity whose `wreckExpiresAt` has
 * passed. Called once per tick by `SimLoop.runOneStep`. No-op if
 * the registry contains no expired wrecks.
 *
 * Returns the number of wrecks removed (for tests + ops dashboards).
 */
export function cleanupExpiredWrecks(shard: Shard, nowMs: number): number {
  let removed = 0;
  for (const [id, entity] of shard.entities) {
    if (entity.kind !== "wreck") continue;
    if (entity.wreckExpiresAt === undefined) continue;
    if (entity.wreckExpiresAt > nowMs) continue;
    shard.entities.delete(id);
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Combat event broadcast
// ---------------------------------------------------------------------------

/**
 * Push one `combat_event` frame to every connection in the shard
 * via the shard's `send` hook. The shard is transport-agnostic; this
 * just walks `shard.connections` and calls `send` for each.
 *
 * Failures from a single connection do not stop the broadcast — a
 * dead client shouldn't take out a combat alert for everyone else.
 *
 * The frame type is asserted via `unknown` because the shard's
 * `send` hook was originally typed for `entity_update` only; combat
 * events are a distinct message type that flows through the same
 * transport. The router unwraps the frame into the wire shape.
 */
export function broadcastCombatEvent(shard: Shard, event: ProtocolCombatEvent): void {
  for (const conn of shard.connections.values()) {
    try {
      shard.send(conn.connId, {
        type: "combat_event",
        payload: event,
      } as unknown as Parameters<typeof shard.send>[1]);
    } catch {
      // Swallow per-connection errors — the broadcast is best-effort.
    }
  }
}
