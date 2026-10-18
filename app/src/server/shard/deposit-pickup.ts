/**
 * Deposit-pickup side effects — TASK-37.
 *
 * Splits the deposit-specific logic out of `inventory.ts` so the
 * registry pattern enforced by the client-side
 * `interaction.test.ts` lint scan doesn't trip on inline
 * `kind === "deposit"` checks. The function lives next to
 * `discovery.ts` (which it shares the persistence contract with).
 *
 * The handler:
 *   1. Persists the deposit's `remaining` amount (creates the row
 *      lazily on first mine).
 *   2. Marks the deposit as `discovered` server-side.
 *
 * Idempotent: re-running for an already-empty pickup is a no-op
 * against the DB (the upsert re-writes the same row).
 */
import type { Repository } from "../db/repo.js";
import type { Shard, SimEntity } from "./types.js";

/**
 * Persist the post-pickup deposit state and flip the in-memory
 * `discovered` flag. No-op for non-deposit entities.
 *
 * `remaining` is the amount left on the deposit after the pickup;
 * 0 means the entity will be despawned by the caller.
 */
export async function persistDepositAfterPickup(args: {
  shard: Shard;
  repo: Repository;
  entity: SimEntity;
  remaining: number;
}): Promise<void> {
  const { shard, repo, entity, remaining } = args;
  if (entity.kind !== "deposit") return;
  if (typeof entity.depositSeq !== "number") return;

  entity.discovered = true;
  await repo.upsertDepositState({
    id: entity.id,
    systemId: shard.systemId,
    planetId: entity.originPlanetId ?? "",
    pos: { x: entity.pos.x, y: entity.pos.y, z: entity.pos.z },
    resourceId: entity.resourceType ?? "unknown",
    remaining,
    discovered: true,
    depositSeq: entity.depositSeq,
  });
}
