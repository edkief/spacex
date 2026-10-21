/**
 * Static-deposit delta push — TASK-18.
 *
 * The 10 Hz broadcast carries only the *dynamic* entity set (ships,
 * characters, AI, wrecks, drones); deposits and terminals are static
 * and are delivered in full on `enter_system` / `warp_arrived`. When
 * a deposit changes (a mining award, a depletion, a refresh) we push
 * a one-entity `entity_update` to every connection instead of waiting
 * for the next full frame that would no longer contain it.
 *
 * One frame per award (the award cadence is `MINE_TICK_MS` = 1.5 s),
 * so the extra bandwidth is a few hundred bytes per second per
 * system — versus the ~33 KB/s the full-stream version spent on
 * re-serializing 120 unchanged deposits at 10 Hz.
 */
import type { ProtocolEntityState } from "@shared/protocol/index.js";
import { entityToWire } from "./entity.js";
import type { Shard } from "./types.js";
import { sendEntityUpdate } from "./index.js";

/** How close a connection must be to see the deposit delta. */
export const DEPOSIT_UPDATE_RADIUS_M = 1500;

/**
 * Push `deposit`'s current wire shape to every connection whose
 * entity is within {@link DEPOSIT_UPDATE_RADIUS_M}. Cheap no-op when
 * nobody is nearby.
 */
export function pushDepositUpdate(shard: Shard, deposit: SimEntityLike): void {
  const wire: ProtocolEntityState = entityToWire(deposit);
  const r2 = DEPOSIT_UPDATE_RADIUS_M * DEPOSIT_UPDATE_RADIUS_M;
  for (const [connId, conn] of shard.connections) {
    const bound = conn.entityId ? shard.entities.get(conn.entityId) : undefined;
    if (bound) {
      const dx = bound.pos.x - deposit.pos.x;
      const dy = bound.pos.y - deposit.pos.y;
      const dz = bound.pos.z - deposit.pos.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
    }
    sendEntityUpdate(shard, connId, shard.sim.currentTick, [wire]);
  }
}

/** Structural minimum the helper needs (keeps the import surface small). */
type SimEntityLike = Parameters<typeof entityToWire>[0];
