/**
 * Deposit hydration — TASK-37.
 *
 * Walks the seed-derived deposit list for a system, mints one
 * `SimEntity` per deposit on the shard, then layers the
 * persisted state (depletion + discovery) on top. Idempotent —
 * re-running with the same inputs yields the same shard.
 *
 * The flow:
 *
 *   1. `depositsFor(seed, systemId)` — seed-derived placement
 *      (positions, initial amounts, resource ids).
 *   2. `repo.listDepositStates(systemId)` — persisted deltas
 *      (current remaining, discovered).
 *   3. For each seed deposit, create an entity with the
 *      persistence values when present, else the seed values.
 *      Persisted discovery flips the in-memory flag via
 *      `applyPersistedDiscovery`.
 *
 * @see ../../shared/world/deposits.ts for `depositsFor`.
 * @see ../shard/discovery.ts for `applyPersistedDiscovery`.
 * @see ./hydrate.ts (TASK-11 pattern) for the entity factory shape.
 */

import { depositsFor, type Deposit } from "@shared/world/deposits.js";
import type { Repository } from "../db/repo.js";
import type { Shard, SimEntity } from "../shard/types.js";
import { applyPersistedDiscovery } from "../shard/discovery.js";

/** HeightAt resolution strategy. Flat by default; the server passes
 * a real surface chunk closure when it has one wired up. */
export type DepositHeightAtFor = (
  planetId: string,
) => ((localX: number, localZ: number) => number) | undefined;

export interface HydrateDepositsOptions {
  repo: Repository;
  heightAtFor?: DepositHeightAtFor;
}

/**
 * Walk the seed-derived deposit list and merge it with the
 * persisted state. Returns the merged list (useful for tests /
 * debug overlays); the shard's entity map is mutated in place.
 */
export function hydrateShardDeposits(
  shard: Shard,
  seed: string,
  options: HydrateDepositsOptions,
): readonly Deposit[] {
  const seedDeposits = depositsFor({
    seed,
    systemId: shard.systemId,
    heightAtFor: options.heightAtFor,
  });
  if (seedDeposits.length === 0) return seedDeposits;

  // Pull persisted state synchronously by deferring the read via
  // `.then(...)` — but the router's hydrate path is async, so we
  // wrap the whole flow in a helper that awaits the list and
  // applies the merge. The function is intentionally NOT async
  // because callers that don't have persistence wired (tests)
  // can still call it.
  void applyPersistedDeposits(shard, seedDeposits, options);
  return seedDeposits;
}

/**
 * Async variant: reads the persisted deposit-state rows from the
 * DB, then applies the merge into the shard's entity map. The
 * sync `hydrateShardDeposits` above kicks this off as a fire-
 * and-forget so non-async callers don't have to `await` it.
 */
export async function applyPersistedDeposits(
  shard: Shard,
  seedDeposits: readonly Deposit[],
  options: HydrateDepositsOptions,
): Promise<void> {
  const persisted = await options.repo.listDepositStates(shard.systemId);
  const persistedBySeq = new Map<number, { remaining: number; discovered: boolean }>();
  for (const row of persisted) {
    persistedBySeq.set(row.depositSeq, {
      remaining: row.remaining,
      discovered: row.discovered,
    });
  }

  // Clear any existing deposit entities (defensive — idempotent
  // re-hydrate must not double-register). Other entity kinds are
  // untouched.
  for (const [id, e] of shard.entities) {
    if (e.kind === "deposit") shard.entities.delete(id);
  }

  const discoveredIds = new Set<string>();
  for (let i = 0; i < seedDeposits.length; i++) {
    const d = seedDeposits[i]!;
    const state = persistedBySeq.get(i);
    const remaining = state?.remaining ?? d.amount;
    const discovered = state?.discovered ?? false;
    if (discovered) discoveredIds.add(d.depositId);
    const entity: SimEntity = {
      id: d.depositId,
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: d.pos.x, y: d.pos.y, z: d.pos.z },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: d.planetId,
      onPad: null,
      resourceType: d.resourceId,
      amount: remaining,
      initialAmount: d.amount,
      depositSeq: i,
      discovered,
    };
    shard.entities.set(d.depositId, entity);
  }

  // Mirror the DB's discovery flag back into memory (defence in
  // depth — the loop above already reads it directly).
  applyPersistedDiscovery(shard, discoveredIds);
}
