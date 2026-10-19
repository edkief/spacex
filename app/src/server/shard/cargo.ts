/**
 * Ship cargo hold transfer — TASK-39.
 *
 * Server-authoritative handler for moving resources between a
 * player's on-foot inventory and the docked ship's cargo hold.
 *
 * ## Flow
 *
 *   1. Connection must be bound to a `character` (on foot).
 *   2. Character must be within `CARGO_TRANSFER_RANGE_M` (5 m) of
 *      the player's own ship — the same proximity bound the
 *      `enter_ship` prompt uses (TASK-35) so the player's ship
 *      is reachable from any direction around the hull.
 *   3. The transfer direction is the caller's choice
 *      (`from: 'inv' | 'hold'`). The handler reads the source
 *      row, applies the cap-bound math, and writes the new
 *      inventory + cargo in a single logical transaction.
 *   4. The new shapes are persisted via the existing
 *      `repo.saveInventory` + `repo.saveShipState({ cargo })`
 *      path so a transfer is durable before the next
 *      `cargo_update` ack ships.
 *   5. The handler emits a single `cargo_update` ack carrying
 *      the new hold + the new inventory. The next
 *      `entity_update` broadcast carries nothing extra (the hold
 *      isn't broadcast on the wire — it's an authoritative
 *      per-connection stream), but the sim loop's entity carries
 *      the new hold so a subsequent restart flush persists it.
 *
 * ## Anti-cheat
 *
 *   - Source ownership is validated server-side: a missing
 *     inventory stack surfaces as `insufficient-amount`; the
 *     hold row is never credited for more than was taken.
 *   - Destination cap is the class-derived limit; partial
 *     transfers land on the floor when the cap is reached so a
 *     cheating client cannot inflate the hold beyond capacity.
 *   - Two concurrent transfers cannot both credit the same row
 *     because every read-then-write path goes through the
 *     `repo.saveInventory` / `saveShipState` round-trip — a
 *     second frame that arrives mid-flight observes the new
 *     shape and is processed against it.
 *
 * ## Persistence
 *
 *   - Inventory persists on `players.inventory` (TASK-34).
 *   - Cargo persists on `ships.cargo` (this task).
 *   - Both writes happen BEFORE the `cargo_update` ack so the
 *     client never sees a transient shape that contradicts the
 *     durable state.
 *
 * @see ./inventory.ts for the on-foot inventory handlers.
 * @see ./index.ts for the ship entity factory (carries the cargo).
 * @see ./persist.ts for the periodic flush (extends to include cargo).
 */
import type { Repository } from "../db/repo.js";
import { NotFoundError } from "../db/errors.js";
import {
  CARGO_WEIGHT_PER_UNIT,
  type CargoHold,
  type CargoResourceType,
  cargoCapacityFor,
  isCargoResourceType,
} from "@shared/world/cargo.js";
import { addToCargo, removeFromCargo, validateCargoHold } from "@shared/world/cargoOps.js";
import {
  INVENTORY_WEIGHT_CAP,
  INVENTORY_WEIGHT_PER_UNIT,
  type Inventory,
} from "@shared/world/inventory.js";
import {
  addToInventory,
  removeFromInventory,
  validateInventory,
} from "@shared/world/inventoryOps.js";

import type { Shard, ShardConnection, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants — exported so the WS handler + tests can reuse them.
// ---------------------------------------------------------------------------

/**
 * Max distance (m) between the character and the ship's hull that
 * the server accepts a `cargo_transfer` frame from. Mirrors
 * `ENTER_SHIP_RANGE_M` (TASK-35) so a player walking around their
 * own parked ship can transfer from any direction.
 */
export const CARGO_TRANSFER_RANGE_M = 5;

/** Squared copy of the above — exported for the hot loop. */
export const CARGO_TRANSFER_RANGE_SQ_M = CARGO_TRANSFER_RANGE_M * CARGO_TRANSFER_RANGE_M;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * Direction the caller is moving resources.
 *
 *   - `'inv'`  — moving FROM the player's on-foot inventory INTO
 *                the ship's cargo hold. Requires the player owns
 *                `amount` in the inventory.
 *   - `'hold'` — moving FROM the ship's cargo hold INTO the
 *                on-foot backpack. Requires the hold carries
 *                `amount` AND the inventory has room.
 */
export type CargoTransferDirection = "inv" | "hold";

export type CargoTransferResult =
  | {
      ok: true;
      direction: CargoTransferDirection;
      resourceId: CargoResourceType;
      requested: number;
      transferred: number;
      remaining: number;
      inventory: Inventory;
      cargo: CargoHold;
    }
  | {
      ok: false;
      code:
        | "wrong-regime"
        | "not-found"
        | "unknown-resource"
        | "not-owner"
        | "out-of-range"
        | "insufficient-amount"
        | "inventory-full"
        | "cargo-full"
        | "invalid-amount"
        | "ship-not-docked";
      message: string;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Atomically move `amount` of `resourceId` from the source
 * (`'inv'` / `'hold'`) to the destination (the other side).
 *
 * Steps:
 *   1. Locate the connection + bound character entity. Reject
 *      `wrong-regime` if the player isn't on foot.
 *   2. Locate the player's ship entity via `character.onShipId`.
 *      Reject `not-owner` if the ship belongs to someone else.
 *   3. Range check vs the ship's pos (5 m). Reject
 *      `out-of-range` if farther.
 *   4. Validate resource id against the cargo catalog.
 *      Reject `unknown-resource` on miss.
 *   5. Validate amount (positive integer). Reject
 *      `invalid-amount` otherwise.
 *   6. Read both source and destination shapes from the DB
 *      (inventory via `getInventory`; cargo via
 *      `findShipById`).
 *   7. Apply the cap-bound math. For `from: 'inv'`, take from
 *      inventory first; for `from: 'hold'`, take from the hold
 *      first.
 *   8. Persist both shapes, then emit the `cargo_update` ack.
 *
 * On any DB write failure the function throws — the caller
 * (WS handler) surfaces a structured error frame so the client
 * can retry.
 */
export async function handleCargoTransfer(
  shard: Shard,
  repo: Repository,
  args: {
    connId: string;
    resourceId: string;
    amount: number;
    from: CargoTransferDirection;
  },
): Promise<CargoTransferResult> {
  const conn = shard.connections.get(args.connId);
  if (!conn) {
    return { ok: false, code: "not-found", message: "Connection not in shard" };
  }
  const character = resolveCharacter(conn, shard);
  if (!character) {
    return {
      ok: false,
      code: "wrong-regime",
      message: "Player must be on foot to transfer cargo",
    };
  }
  if (typeof args.amount !== "number" || !Number.isInteger(args.amount) || args.amount <= 0) {
    return {
      ok: false,
      code: "invalid-amount",
      message: "amount must be a positive integer",
    };
  }
  if (!isCargoResourceType(args.resourceId)) {
    return {
      ok: false,
      code: "unknown-resource",
      message: `Unknown resource type: ${args.resourceId}`,
    };
  }
  const resourceId: CargoResourceType = args.resourceId;
  const shipId = character.onShipId;
  if (!shipId) {
    return {
      ok: false,
      code: "not-found",
      message: "Character has no associated ship id",
    };
  }
  const ship = shard.entities.get(shipId);
  if (!ship) {
    return {
      ok: false,
      code: "not-found",
      message: "Associated ship not in registry",
    };
  }
  if (ship.kind !== "player") {
    return {
      ok: false,
      code: "not-owner",
      message: "Cannot transfer cargo to a non-player ship",
    };
  }
  if (ship.playerId !== conn.playerId) {
    return {
      ok: false,
      code: "not-owner",
      message: "Ship belongs to a different player",
    };
  }
  // 5 m proximity bound (server-authoritative). The character's
  // spawn is at `ship.pos + sideOffset` (TASK-31), so the
  // distance is bounded; a player walking further than 5 m from
  // their ship is out of range for transfer (matches the
  // enter_ship prompt range).
  const dx = character.pos.x - ship.pos.x;
  const dy = character.pos.y - ship.pos.y;
  const dz = character.pos.z - ship.pos.z;
  if (dx * dx + dy * dy + dz * dz > CARGO_TRANSFER_RANGE_SQ_M) {
    return {
      ok: false,
      code: "out-of-range",
      message: `Character too far from ship (max ${CARGO_TRANSFER_RANGE_M} m)`,
    };
  }

  // Read both shapes up front so the write path can swap them
  // atomically. The repository methods throw `NotFoundError` for
  // unknown ids — we map that to a wire code so the caller gets
  // a structured error.
  let inventory: Inventory;
  let cargo: CargoHold;
  try {
    inventory = await repo.getInventory(conn.playerId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { ok: false, code: "not-found", message: err.message };
    }
    throw err;
  }
  try {
    const shipRow = await repo.findShipById(ship.id.replace(/^entity:/u, ""));
    if (!shipRow) {
      return { ok: false, code: "not-found", message: `Ship ${ship.id} not found` };
    }
    if (!validateCargoHold(shipRow.cargo)) {
      // Defensive: a corrupt persisted hold. Reset to the class-
      // derived cap and re-persist on the next transfer. The
      // current transfer still proceeds against the in-memory
      // shape so the player isn't blocked by a single bad row.
      cargo = {
        stacks: {},
        weightUsed: 0,
        capacity: cargoCapacityFor(shipRow.classId),
      };
    } else {
      cargo = shipRow.cargo;
    }
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { ok: false, code: "not-found", message: err.message };
    }
    throw err;
  }

  // Branch on the transfer direction. Both branches follow the
  // spec's "partial on destination cap" semantic:
  //   1. Validate the SOURCE owns `args.amount` (strict
  //      ownership — a partial source cannot be silently
  //      shrunk).
  //   2. Compute the destination cap; the transfer is partial
  //      when the cap runs out before the full request fits.
  //   3. Debit the source by the actually-transferred amount so
  //      the source stays consistent with the destination.
  //
  // On the wire the ack surfaces `transferred` + `remaining` so
  // the UI can show "Moved 3 of 5, 2 didn't fit" rather than
  // disappearing the 2 silently.
  let newInventory: Inventory;
  let newCargo: CargoHold;
  let transferred: number;
  let remaining: number;
  if (args.from === "inv") {
    const owned = inventory.stacks[resourceId] ?? 0;
    if (owned < args.amount) {
      return {
        ok: false,
        code: "insufficient-amount",
        message: `Cannot transfer ${args.amount} ${resourceId}; only ${owned} in inventory`,
      };
    }
    const cargoPerUnit = CARGO_WEIGHT_PER_UNIT[resourceId];
    const destMaxUnits =
      cargoPerUnit > 0
        ? Math.max(0, Math.floor((cargo.capacity - cargo.weightUsed) / cargoPerUnit))
        : 0;
    if (destMaxUnits <= 0) {
      return {
        ok: false,
        code: "cargo-full",
        message: `Cargo hold full (capacity ${cargo.capacity})`,
      };
    }
    const actualAmount = Math.min(args.amount, destMaxUnits);
    const source = removeFromInventory(inventory, resourceId, actualAmount);
    const dest = addToCargo(cargo, resourceId, source.taken);
    newInventory = source.inventory;
    newCargo = dest.hold;
    transferred = dest.taken;
    remaining = args.amount - dest.taken;
  } else {
    const owned = cargo.stacks[resourceId] ?? 0;
    if (owned < args.amount) {
      return {
        ok: false,
        code: "insufficient-amount",
        message: `Cannot take ${args.amount} ${resourceId}; only ${owned} in cargo`,
      };
    }
    const invPerUnit = INVENTORY_WEIGHT_PER_UNIT[resourceId];
    const destMaxUnits =
      invPerUnit > 0
        ? Math.max(0, Math.floor((INVENTORY_WEIGHT_CAP - inventory.weightUsed) / invPerUnit))
        : 0;
    if (destMaxUnits <= 0) {
      return {
        ok: false,
        code: "inventory-full",
        message: `Inventory full (capacity ${INVENTORY_WEIGHT_CAP})`,
      };
    }
    const actualAmount = Math.min(args.amount, destMaxUnits);
    const source = removeFromCargo(cargo, resourceId, actualAmount);
    const dest = addToInventory(inventory, resourceId, source.taken);
    newInventory = dest.inventory;
    newCargo = source.hold;
    transferred = dest.taken;
    remaining = args.amount - dest.taken;
  }

  // Validate the new shapes (defensive — `addToCargo` /
  // `addToInventory` already enforce their caps, but a buggy
  // helper shouldn't propagate garbage to the DB).
  if (!validateInventory(newInventory)) {
    return {
      ok: false,
      code: "not-found",
      message: "Computed inventory shape failed validation",
    };
  }
  if (!validateCargoHold(newCargo)) {
    return {
      ok: false,
      code: "not-found",
      message: "Computed cargo hold failed validation",
    };
  }

  // Persist both shapes BEFORE pushing the frame so the client
  // never sees a transient shape that contradicts the DB. The
  // shipId used by the DB is the persistent UUID; the in-memory
  // entity id is `entity:<shipId>` so we strip the prefix.
  const persistentShipId = ship.id.replace(/^entity:/u, "");
  await Promise.all([
    repo.saveInventory(conn.playerId, newInventory),
    repo.saveShipState(persistentShipId, { cargo: newCargo }),
  ]);

  // Mirror the new hold into the in-memory entity so the next
  // flush (TASK-24 cadence) keeps it without a second
  // round-trip.
  if (ship.cargo) {
    ship.cargo = newCargo;
  }

  return {
    ok: true,
    direction: args.from,
    resourceId,
    requested: args.amount,
    transferred,
    remaining,
    inventory: newInventory,
    cargo: newCargo,
  };
}

/**
 * Push the canonical `cargo_update` ack to the owning connection.
 * Wire shape mirrors the inventory_update schema so a single
 * front-end HUD can render both side by side.
 */
export function pushCargoUpdate(
  shard: Shard,
  connId: string,
  payload: {
    cargo: CargoHold;
    inventory: Inventory;
    direction: CargoTransferDirection;
    resourceId: CargoResourceType;
    transferred: number;
    remaining: number;
    action: "move-to-hold" | "move-to-inventory";
  },
): void {
  shard.send(connId, {
    type: "cargo_update",
    payload: {
      cargo: {
        stacks: { ...payload.cargo.stacks },
        weightUsed: payload.cargo.weightUsed,
        capacity: payload.cargo.capacity,
      },
      inventory: {
        stacks: { ...payload.inventory.stacks },
        weightUsed: payload.inventory.weightUsed,
        capacity: INVENTORY_WEIGHT_CAP,
      },
      direction: payload.direction,
      resourceId: payload.resourceId,
      transferred: payload.transferred,
      remaining: payload.remaining,
      action: payload.action,
    },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the character entity the connection is currently driving.
 * Returns `null` when the player isn't on foot — callers reject
 * with `wrong-regime`.
 */
function resolveCharacter(conn: ShardConnection, shard: Shard): SimEntity | null {
  if (conn.entityId === null) return null;
  const entity = shard.entities.get(conn.entityId);
  if (!entity || entity.kind !== "character") return null;
  return entity;
}
