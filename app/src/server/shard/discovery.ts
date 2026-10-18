/**
 * Deposit discovery — TASK-37.
 *
 * A deposit is "discovered" the first time any player comes within
 * `DISCOVERY_RANGE_M = 50` of it. The flag is persisted via
 * `upsertDepositState` so it survives a server restart and feeds
 * the star-chart resource summary (out of scope for v1; the flag
 * is wired through anyway).
 *
 * The discovery pass walks the shard's deposit entities once per
 * tick (or on demand) and flips the flag + writes the row when a
 * connected player crosses the threshold. Players within range
 * come from the shard's `connections` map; the character entity's
 * position is the discovery anchor (matches the cone-raycast in
 * `@client/input/interaction.ts`).
 *
 * The module is pure — no globals, no `Date.now()` plumbed
 * through the hot loop. Callers pass the current `nowMs` for the
 * discovery bookkeeping tick so the test suite can drive it with
 * a fake clock.
 */
import type { Repository } from "../db/repo.js";
import { DISCOVERY_RANGE_M, type Deposit } from "@shared/world/deposits.js";
import type { Shard, ShardConnection, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Squared version of the discovery radius — used in the hot loop. */
const DISCOVERY_RANGE_SQ_M = DISCOVERY_RANGE_M * DISCOVERY_RANGE_M;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk the shard's deposit entities; for each one still flagged
 * `discovered: false`, check every connected player's character
 * (or docked ship) position against the discovery radius. Flip
 * the flag in-memory and persist via `upsertDepositState`.
 *
 * Returns the number of newly-discovered deposits (in-memory +
 * persisted). Idempotent — a deposit that's already discovered
 * short-circuits without a DB write.
 */
export async function discoverNearbyDeposits(
  shard: Shard,
  repo: Repository,
  depositsById: ReadonlyMap<string, Deposit>,
): Promise<number> {
  let discovered = 0;
  for (const [entityId, entity] of shard.entities) {
    if (entity.kind !== "deposit") continue;
    const deposit = depositsById.get(entityId);
    if (!deposit) continue;
    if (entity.discovered === true) continue;

    const found = anyPlayerInRange(shard, entity);
    if (!found) continue;

    entity.discovered = true;
    discovered++;
    // Persist the flip so it survives a server restart. The row may
    // not exist yet (lazy creation); upsert handles both insert and
    // update paths.
    if (typeof entity.depositSeq === "number") {
      await repo.upsertDepositState({
        id: entity.id,
        systemId: shard.systemId,
        planetId: entity.originPlanetId ?? deposit.planetId,
        pos: { x: entity.pos.x, y: entity.pos.y, z: entity.pos.z },
        resourceId: deposit.resourceId,
        remaining: typeof entity.amount === "number" ? entity.amount : deposit.amount,
        discovered: true,
        depositSeq: entity.depositSeq,
      });
    }
  }
  return discovered;
}

/**
 * Reset every deposit's in-memory `discovered` flag based on the
 * persisted `discovered` rows. Called on shard hydrate so the
 * in-memory state mirrors the DB. A deposit that's flagged
 * `discovered: true` in the DB stays `discovered: true` in memory;
 * one that's missing from the DB starts at `false`.
 */
export function applyPersistedDiscovery(shard: Shard, discoveredIds: ReadonlySet<string>): void {
  for (const entity of shard.entities.values()) {
    if (entity.kind !== "deposit") continue;
    if (discoveredIds.has(entity.id)) {
      entity.discovered = true;
    } else {
      entity.discovered = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when at least one connected player has a character / ship
 * within `DISCOVERY_RANGE_M` of the deposit. Players that are
 * mid-flight count too (their ship's pos is the anchor); only the
 * owning entity of the connection matters.
 */
function anyPlayerInRange(shard: Shard, entity: SimEntity): boolean {
  for (const conn of shard.connections.values()) {
    const playerPos = playerAnchorPos(shard, conn);
    if (!playerPos) continue;
    if (distSq(playerPos, entity.pos) <= DISCOVERY_RANGE_SQ_M) return true;
  }
  return false;
}

/**
 * Resolve the player's authoritative position for discovery:
 *
 *   - If the connection is driving a character entity, use that.
 *   - If the connection is driving a docked ship, fall back to the
 *     ship's position so a player hovering above a deposit still
 *     triggers discovery (the HUD prompt fires at the character's
 *     range, but the discovery flag is the server's call).
 *
 * Returns `null` for connections without a bound entity yet (the
 * sim tick hasn't run).
 */
function playerAnchorPos(
  shard: Shard,
  conn: ShardConnection,
): { x: number; y: number; z: number } | null {
  if (!conn.entityId) return null;
  const entity = shard.entities.get(conn.entityId);
  if (!entity) return null;
  return entity.pos;
}

/** Squared Euclidean distance between two world-space points. */
function distSq(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
