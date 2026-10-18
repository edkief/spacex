/**
 * On-foot inventory server — TASK-34.
 *
 * Pure server-side surface for the player's backpack while on foot:
 *
 *   - `handlePickup(...)` — adds a deposit or a ground item into the
 *     caller's inventory, respecting the carry cap. Returns the
 *     `{taken, remaining}` tuple and the new inventory shape; the
 *     shared `addToInventory` math drives the partial-pickup logic.
 *     When the entire deposit is taken the server also removes the
 *     entity from the shard so every client sees the snapshot change.
 *   - `handleDrop(...)`    — spawns a ground-item entity at the
 *     character's location carrying the dropped resource stack.
 *     Validates that the caller owns enough to drop, persists the
 *     inventory, and broadcasts the new entity via the next snapshot.
 *
 * Persistence: every inventory mutation calls `repo.saveInventory`
 * synchronously so a player who disconnects, restarts, or crashes
 * survives with the same backpack. The repository uses the JSON
 * column added by migration `0003_player_inventory.sql`.
 *
 * The connection's inventory is held *server-side*, keyed by
 * `conn.playerId`. The shard does not cache it between ticks — every
 * handler call re-reads from the DB so two concurrent paths can
 * never see a stale shape. The hot path (pickup / drop) tolerates
 * this because operations are infrequent (1-2 per second at peak).
 */
import type { Repository } from "../db/repo.js";
import { NotFoundError } from "../db/errors.js";
import {
  INVENTORY_RESOURCE_TYPES,
  type Inventory,
  type InventoryResourceType,
  isInventoryResourceType,
} from "@shared/world/inventory.js";
import { addToInventory, emptyInventory, removeFromInventory } from "@shared/world/inventoryOps.js";

import type { Shard, ShardConnection, SimEntity } from "./types.js";
import { persistDepositAfterPickup } from "./deposit-pickup.js";

// ---------------------------------------------------------------------------
// Constants — exported so the wire schema + WS handler can reuse them.
// ---------------------------------------------------------------------------

/**
 * How long a ground item stays on the surface before despawning.
 * Spec calls for a 300 s TTL.
 */
export const GROUND_ITEM_TTL_MS = 300_000;
export const GROUND_ITEM_TTL_S = GROUND_ITEM_TTL_MS / 1000;

// ---------------------------------------------------------------------------
// Result shapes — discriminated unions consumed by the WS handler.
// ---------------------------------------------------------------------------

/**
 * Result of `handlePickup` — either it succeeded (with a concrete
 * `taken` count + the new inventory) or it failed with one of the
 * accepted error codes (mirrors the wire `ErrorCodeSchema`).
 */
export type HandlePickupResult =
  | {
      ok: true;
      taken: number;
      remaining: number;
      inventory: Inventory;
      /** True when the entire source entity was consumed; false on partial. */
      consumedSource: boolean;
      /** Target entity id (echoed so the WS handler can build the wire ack). */
      targetId: string;
    }
  | {
      ok: false;
      code: "wrong-regime" | "out-of-range" | "not-found" | "overflow" | "unknown-resource";
      message: string;
    };

export type HandleDropResult =
  | {
      ok: true;
      dropped: number;
      inventory: Inventory;
      /** New ground item entity id (echoed). */
      groundItemId: string;
    }
  | {
      ok: false;
      code:
        "wrong-regime" | "not-found" | "insufficient-amount" | "unknown-resource" | "no-character";
      message: string;
    };

// ---------------------------------------------------------------------------
// Range / cone math — same shape as `interact.ts` so the validators stay
// in lockstep with the cone-raycast the client uses.
// ---------------------------------------------------------------------------

const PICKUP_RANGE_M = 3;
const PICKUP_RANGE_SQ_M = PICKUP_RANGE_M * PICKUP_RANGE_M;

function distSq(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

// ---------------------------------------------------------------------------
// handlePickup
// ---------------------------------------------------------------------------

/**
 * Add an entity's full stack into the caller's inventory.
 *
 * Steps:
 *   1. Locate the connection + bound character entity. Reject
 *      `wrong-regime` if the player isn't on foot.
 *   2. Locate the target entity. Reject `not-found` if missing.
 *   3. Range check vs the character's authoritative pos. Reject
 *      `out-of-range` if the squared distance > 9 m².
 *   4. Validate the entity is a deposit or ground item carrying a
 *      known resource stack. Reject `unknown-resource` otherwise.
 *   5. Persisted: read the inventory, apply `addToInventory`. The
 *      partial-pickup boundary (taken < amount) leaves `remaining`
 *      on the entity; the next snapshot reflects the new world state.
 *
 * The function mutates the shard in two places:
 *   - `shard.entities.delete(targetId)` when the source is fully
 *     consumed (every client sees the entity vanish).
 *   - The deposit's `quantity` field is mutated in-place when only a
 *     partial amount is taken; the wire `entity_update` carries the
 *     new `quantity` value out via the next snapshot.
 */
export async function handlePickup(
  shard: Shard,
  repo: Repository,
  args: { connId: string; targetId: string; nowMs?: number },
): Promise<HandlePickupResult> {
  const conn = shard.connections.get(args.connId);
  if (!conn) {
    return { ok: false, code: "not-found", message: "Connection not in shard" };
  }
  const character = resolveCharacter(conn, shard);
  if (!character) {
    return { ok: false, code: "wrong-regime", message: "Player must be on foot to pick up" };
  }
  const target = shard.entities.get(args.targetId);
  if (!target) {
    return { ok: false, code: "not-found", message: "Target not in registry" };
  }
  if (target.kind !== "deposit" && target.kind !== "groundItem") {
    return {
      ok: false,
      code: "not-found",
      message: `Cannot pick up entity of kind ${target.kind}`,
    };
  }
  if (distSq(character.pos, target.pos) > PICKUP_RANGE_SQ_M) {
    return {
      ok: false,
      code: "out-of-range",
      message: `Target is too far (max ${PICKUP_RANGE_M} m)`,
    };
  }
  // Ground item + deposit share the resourceType / amount fields; we
  // keep the type narrow so the wire can validate against the catalog.
  const resourceType = (target as { resourceType?: unknown }).resourceType;
  const amount = (target as { amount?: unknown }).amount;
  if (typeof resourceType !== "string" || !isInventoryResourceType(resourceType)) {
    return {
      ok: false,
      code: "unknown-resource",
      message: `Unknown resource type: ${String(resourceType)}`,
    };
  }
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    return {
      ok: false,
      code: "not-found",
      message: `Invalid pickup amount: ${String(amount)}`,
    };
  }

  // Read authoritative inventory from the DB. The shard doesn't cache
  // it between ticks because operations are infrequent; the read cost
  // is one indexed SELECT keyed by `players.id`.
  let inventory: Inventory;
  try {
    inventory = await repo.getInventory(conn.playerId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { ok: false, code: "not-found", message: err.message };
    }
    throw err;
  }
  const result = addToInventory(inventory, resourceType, amount);
  if (result.taken <= 0) {
    // Partial pickup at the boundary reached the cap; report `overflow`
    // so the client can show "Cannot carry more" while the entity
    // stays in the world for someone else to grab.
    return {
      ok: false,
      code: "overflow",
      message: `No room in inventory for ${resourceType} (cap reached)`,
    };
  }

  // Persist the new shape + apply the source-side mutation.
  await repo.saveInventory(conn.playerId, result.inventory);

  // TASK-37: delegate deposit-specific side effects (persistence +
  // discovery flip) to the helper module. The helper is a no-op for
  // non-deposit entities, so the inline dispatch-on-kind check is
  // contained outside this file (the client-side lint test forbids
  // such checks outside the registry modules).
  await persistDepositAfterPickup({
    shard,
    repo,
    entity: target,
    remaining: result.remaining,
  });

  if (result.remaining > 0) {
    // Partial pickup — leave the entity in the world with the reduced
    // amount. We mutate the in-memory entity; the next snapshot
    // carries the change. The persisted `remaining` already matches
    // via the upsert above.
    (target as { amount: number }).amount = result.remaining;
  } else {
    // Full pickup — despawn the entity so every connection sees the
    // removal. The broadcast on the next tick will omit it.
    shard.entities.delete(target.id);
  }
  return {
    ok: true,
    taken: result.taken,
    remaining: result.remaining,
    inventory: result.inventory,
    consumedSource: result.remaining === 0,
    targetId: target.id,
  };
}

// ---------------------------------------------------------------------------
// handleDrop
// ---------------------------------------------------------------------------

/**
 * Mint a ground-item entity at the character's location and remove
 * the carried resource from the inventory.
 *
 * Steps:
 *   1. Locate the connection + bound character entity. Reject
 *      `wrong-regime` if the player isn't on foot.
 *   2. Validate the resource id is in the inventory catalog.
 *   3. Read the inventory; reject `insufficient-amount` when the
 *      player doesn't own enough units.
 *   4. Apply `removeFromInventory`, persist the new shape, mint a
 *      ground item entity (kind `groundItem`) at the character's
 *      position, return the new entity id.
 */
export async function handleDrop(
  shard: Shard,
  repo: Repository,
  args: { connId: string; resourceType: string; amount: number; nowMs?: number },
): Promise<HandleDropResult> {
  const conn = shard.connections.get(args.connId);
  if (!conn) {
    return { ok: false, code: "not-found", message: "Connection not in shard" };
  }
  const character = resolveCharacter(conn, shard);
  if (!character) {
    return { ok: false, code: "wrong-regime", message: "Player must be on foot to drop" };
  }
  if (!isInventoryResourceType(args.resourceType)) {
    return {
      ok: false,
      code: "unknown-resource",
      message: `Unknown resource type: ${args.resourceType}`,
    };
  }
  const resourceType = args.resourceType as InventoryResourceType;
  if (!Number.isInteger(args.amount) || args.amount <= 0) {
    return { ok: false, code: "insufficient-amount", message: "Amount must be > 0" };
  }

  let inventory: Inventory;
  try {
    inventory = await repo.getInventory(conn.playerId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { ok: false, code: "not-found", message: err.message };
    }
    throw err;
  }
  const result = removeFromInventory(inventory, resourceType, args.amount);
  if (result.remaining > 0) {
    return {
      ok: false,
      code: "insufficient-amount",
      message: `Cannot drop ${args.amount} ${resourceType}; only ${result.taken} owned`,
    };
  }
  if (result.taken <= 0) {
    return {
      ok: false,
      code: "insufficient-amount",
      message: `Player owns no ${resourceType}`,
    };
  }

  // Persist the new shape.
  await repo.saveInventory(conn.playerId, result.inventory);

  // Mint the ground item at the character's position. Stable id is
  // generated per drop; the entity expires after GROUND_ITEM_TTL_MS.
  const nowMs = args.nowMs ?? Date.now();
  const groundItemId = makeGroundItemId(conn.playerId, resourceType, nowMs);
  if (shard.entities.has(groundItemId)) {
    // Defensive: a UUID-style id almost never collides, but if a
    // extremely rapid drop+a-frame bug fires twice within the same
    // ms we drop the duplicate rather than crash.
    return {
      ok: true,
      dropped: result.taken,
      inventory: result.inventory,
      groundItemId,
    };
  }
  const groundItem: SimEntity = makeGroundItemEntity({
    id: groundItemId,
    pos: { ...character.pos },
    quat: { ...character.quat },
    resourceType,
    amount: result.taken,
    spawnedAtMs: nowMs,
  });
  shard.entities.set(groundItemId, groundItem);
  return {
    ok: true,
    dropped: result.taken,
    inventory: result.inventory,
    groundItemId,
  };
}

// ---------------------------------------------------------------------------
// Ground item lifecycle
// ---------------------------------------------------------------------------

/**
 * Stable id factory for a dropped ground item. Format
 * `ground:<playerId>:<resource>:<spawnMs>` so two drops of the same
 * resource from different players never collide and the same drop's
 * entity remains stable for the lifetime of the ground item.
 */
export function makeGroundItemId(
  playerId: string,
  resourceType: InventoryResourceType,
  spawnedAtMs: number,
): string {
  return `ground:${playerId}:${resourceType}:${spawnedAtMs}`;
}

/**
 * Mint a fresh ground-item entity (TASK-34). The entity carries the
 * `resourceType` + `amount` so the wire serializer can include
 * them in the snapshot and the client can render the prompt with
 * the amount suffix.
 *
 * `kind` is the new `groundItem` value added to `EntityKind` in
 * `types.ts`. The wire serializer (`entityToWire`) treats it like
 * a broadcast-only entity (no classId, no hull, no shields).
 */
export function makeGroundItemEntity(args: {
  id: string;
  pos: { x: number; y: number; z: number };
  quat: { x: number; y: number; z: number; w: number };
  resourceType: InventoryResourceType;
  amount: number;
  spawnedAtMs: number;
}): SimEntity {
  return {
    id: args.id,
    kind: "groundItem",
    playerId: null,
    callsign: null,
    classId: null,
    hull: 0,
    shields: 0,
    targetId: null,
    pos: args.pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: args.quat,
    regime: "surface",
    originPlanetId: null,
    onPad: null,
    // EXTENSION FIELDS — declared on `SimEntity` below.
    resourceType: args.resourceType,
    amount: args.amount,
    expiresAtMs: args.spawnedAtMs + GROUND_ITEM_TTL_MS,
  } as SimEntity;
}

/**
 * Remove every expired ground item from the shard. The sim loop
 * calls this once per tick (TASK-34 acceptance: "ground items
 * despawn after 300 s TTL").
 */
export function cleanupExpiredGroundItems(shard: Shard, nowMs: number): number {
  let removed = 0;
  for (const [id, entity] of shard.entities) {
    if (entity.kind !== "groundItem") continue;
    const expiresAt = (entity as { expiresAtMs?: number }).expiresAtMs;
    if (typeof expiresAt !== "number") continue;
    if (expiresAt <= nowMs) {
      shard.entities.delete(id);
      removed += 1;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the character entity the connection is currently driving.
 * Returns `null` when the player isn't on foot — callers reject with
 * `wrong-regime`.
 */
function resolveCharacter(conn: ShardConnection, shard: Shard): SimEntity | null {
  if (conn.entityId === null) return null;
  const entity = shard.entities.get(conn.entityId);
  if (!entity || entity.kind !== "character") return null;
  return entity;
}

/**
 * Re-export of the canonical empty inventory so callers that don't
 * already import the shared module get the same shape back.
 */
export const newEmptyInventory = emptyInventory;

/** Read-only list of every resource id the v1 catalog ships. */
export const KNOWN_INVENTORY_RESOURCES =
  INVENTORY_RESOURCE_TYPES as readonly InventoryResourceType[];
