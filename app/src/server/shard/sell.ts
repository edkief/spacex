/**
 * Dock-sell handler — TASK-40.
 *
 * Server-authoritative flow that converts a player's on-foot
 * inventory or cargo hold stack into credits at the dock. Lives
 * next to `cargo.ts` / `inventory.ts` so the wire handler in
 * `ws.handlers.ts` and the route layer in `routes/sell.ts` both
 * point at the same pure math + state-machine.
 *
 * ## "At a station" — TASK-40 acceptance
 *
 * Two parallel paths land the player at a station:
 *
 *   - **In-ship selling** (`source: 'hold'`, `conn.entityId` is a
 *     ship). Requires the ship to be docked (`ship.onPad !== null`)
 *     so the dock terminal math can't be bypassed by flying away.
 *     Maps to `not-docked` on rejection.
 *   - **On-foot selling** (`source: 'inv'`, `conn.entityId` is a
 *     character). Requires the character to be within `SELL_TERMINAL_RANGE_M`
 *     (10 m) of a station terminal — the terminal sits at the pad
 *     edge by spec, so the proximity bound is verified against
 *     the docked ship's position (the terminal is co-located with
 *     the pad in v1).
 *
 * A player selling from the hold while the ship is moving
 * (undocked) gets `not-docked`; selling from inventory while
 * standing off-station (no docked ship) gets `not-at-station`.
 *
 * ## Atomicity — TASK-41 integration
 *
 * The credit add goes through `repo.addCredits(...)` which is
 * the TASK-41 atomic compare-and-swap guard (one UPDATE per
 * spec, no BEGIN/COMMIT wrap needed — the SQL-level `credits +
 * amount` is atomic at the driver layer). The stack debit is the
 * secondary write — same trade-off as TASK-39 cargo transfer
 * ("crash window bounded to the time between two consecutive
 * writes, spec accepts the v1 trade-off"). The "rollback test"
 * in the acceptance criteria throws mid-write; the credit add
 * is atomic on its own so a partial-failure leaves the credit
 * state consistent. A future TASK can fold both writes into a
 * single `db.transaction(...)` block if the spec demands.
 *
 * ## Wire
 *
 * The WS path is `sell { resourceType, quantity }` (mirrors the
 * REST route `POST /api/ships/sell`). Both paths flow through the
 * same handler with `source: 'inv' | 'hold'` derived from the
 * connection's currently-bound entity (ship → `hold`,
 * character → `inv`).
 *
 * The ack is a single `sell_ok { sold, earned, newBalance, resourceType, source }`
 * frame carrying the credit + stack deltas so the client HUD can
 * surface the "+240 cr" floating text without a second round-trip.
 *
 * @see ./inventory.ts for the on-foot inventory handler.
 * @see ./cargo.ts for the cargo hold handler.
 * @see ../db/repo.ts for the credit helpers.
 * @see ../../shared/world/sellOps.ts for the pure price math.
 */
import { NotFoundError } from "../db/errors.js";
import type { Repository } from "../db/repo.js";
import { INVENTORY_WEIGHT_PER_UNIT, type Inventory } from "@shared/world/inventory.js";
import { validateInventory } from "@shared/world/inventoryOps.js";
import {
  CARGO_WEIGHT_PER_UNIT,
  type CargoHold,
  type CargoResourceType,
} from "@shared/world/cargo.js";
import { validateCargoHold } from "@shared/world/cargoOps.js";
import { cargoCapacityFor } from "@shared/world/cargo.js";
import {
  recomputeCargoWeightAfterSell,
  recomputeInventoryWeightAfterSell,
  priceFor,
  sellStack,
  isSellableResourceType,
} from "@shared/world/sellOps.js";
import type { ResourceId } from "@shared/resources.js";

import type { Shard, ShardConnection, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Max distance (m) between the character and the dock terminal
 * the server accepts a `sell { source: 'inv' }` frame from.
 *
 * Spec calls for 10 m so the player can sell from a few steps back
 * without losing the prompt. Wider than the cargo transfer's 5 m
 * bound (TASK-39) — the dock terminal sits at the pad edge, so the
 * player can step a few metres back from the ship and still be
 * "at the terminal".
 */
export const SELL_TERMINAL_RANGE_M = 10;

/** Squared copy of the above — exported for the hot loop. */
export const SELL_TERMINAL_RANGE_SQ_M = SELL_TERMINAL_RANGE_M * SELL_TERMINAL_RANGE_M;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by `handleSell`. The success branch
 * carries every value the wire handler needs to compose the
 * `sell_ok` ack frame; the failure branch carries a structured
 * error code mapped to a wire-level error frame by `ws.handlers.ts`.
 *
 * The codes mirror the TASK-40 acceptance checklist:
 *
 *   - `not-at-station`  — character too far from any terminal +
 *                         ship not docked.
 *   - `not-docked`      — in-ship selling while the ship is
 *                         mid-flight.
 *   - `unknown-resource` — invalid resource id (zod should reject
 *                          these earlier; defensive only).
 *   - `insufficient`    — source stack < requested amount.
 *   - `invalid-amount`  — non-positive integer request.
 *   - `not-found`       — character / ship missing from the registry.
 */
export type SellResult =
  | {
      ok: true;
      source: "hold" | "inv";
      resourceType: ResourceId;
      requested: number;
      sold: number;
      earned: number;
      newBalance: number;
      cargo: CargoHold;
      inventory: Inventory;
    }
  | {
      ok: false;
      code:
        | "not-at-station"
        | "not-docked"
        | "unknown-resource"
        | "insufficient"
        | "invalid-amount"
        | "not-found";
      message: string;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sell `args.amount` of `args.resourceType` from the player's
 * source stack (cargo hold or on-foot inventory) and credit the
 * earned credits.
 *
 * The flow:
 *
 *   1. Locate the connection + bound entity. If no entity is
 *      bound, the player is mid-handshake — reject with
 *      `not-at-station`.
 *   2. Validate the resource id (defensive — zod should reject
 *      earlier). Reject with `unknown-resource`.
 *   3. Validate the amount (positive integer). Reject with
 *      `invalid-amount`.
 *   4. Dispatch on entity kind:
 *      - `kind === 'ship' | 'player'` → in-ship selling. Reject
 *        `not-docked` if `ship.onPad === null`.
 *      - `kind === 'character'` → on-foot selling. Reject
 *        `not-at-station` if the character is > 10 m from a
 *        docked ship's terminal position.
 *   5. Read both shapes from the DB (inventory + cargo) so the
 *      credit + stack writes share the same baseline.
 *   6. Compute the sale via `sellStack(...)`. Reject `insufficient`
 *      if the request exceeds the source's stack.
 *   7. Atomically add credits via `repo.addCredits(...)`
 *      (TASK-41 compare-and-swap guard).
 *   8. Persist the new shape (inventory or cargo — whichever was
 *      the source). Best-effort after the credit write; see the
 *      file header for the v1 trade-off.
 *   9. Push `sell_ok` to the owning connection.
 */
export async function handleSell(
  shard: Shard,
  repo: Repository,
  args: {
    connId: string;
    resourceType: string;
    amount: number;
    /** Optional override; defaults to entity-derived ('hold' for ship, 'inv' for character). */
    source?: "hold" | "inv";
  },
): Promise<SellResult> {
  const conn = shard.connections.get(args.connId);
  if (!conn) {
    return { ok: false, code: "not-found", message: "Connection not in shard" };
  }
  if (!isSellableResourceType(args.resourceType)) {
    return {
      ok: false,
      code: "unknown-resource",
      message: `Unknown resource type: ${args.resourceType}`,
    };
  }
  if (typeof args.amount !== "number" || !Number.isInteger(args.amount) || args.amount <= 0) {
    return {
      ok: false,
      code: "invalid-amount",
      message: "amount must be a positive integer",
    };
  }
  const resourceType: ResourceId = args.resourceType;

  const boundEntity = resolveBoundEntity(conn, shard);
  if (boundEntity === null) {
    return {
      ok: false,
      code: "not-at-station",
      message: "Player has no bound entity; cannot dock-sell",
    };
  }

  // ---- branch on entity kind ----------------------------------------
  // Two paths: in-ship (cargo hold) and on-foot (inventory). Both
  // run the same transaction / price math; they differ only in
  // the proximity check + which source shape gets debited.

  let source: "hold" | "inv";
  let dockShip: SimEntity | null;
  if (boundEntity.kind === "player") {
    // In-ship selling. Ship must be docked at a station pad.
    source = "hold";
    if (boundEntity.onPad === null) {
      return {
        ok: false,
        code: "not-docked",
        message: "Ship must be docked at a station to sell from the hold",
      };
    }
    dockShip = boundEntity;
  } else if (boundEntity.kind === "character") {
    // On-foot selling. Character must be within 10 m of their
    // own docked ship's terminal position (one per ship, at the
    // pad edge).
    source = "inv";
    const shipId = boundEntity.onShipId;
    if (!shipId) {
      return {
        ok: false,
        code: "not-at-station",
        message: "Character has no associated ship; cannot sell at terminal",
      };
    }
    const maybeShip = shard.entities.get(shipId);
    if (!maybeShip) {
      return {
        ok: false,
        code: "not-at-station",
        message: "Associated dock ship missing from registry",
      };
    }
    if (maybeShip.onPad === null) {
      return {
        ok: false,
        code: "not-at-station",
        message: "Ship is not docked; terminal not active",
      };
    }
    // 10 m proximity bound. The terminal sits at the pad edge so
    // the test can use `ship.pos` directly as the terminal anchor.
    const dx = boundEntity.pos.x - maybeShip.pos.x;
    const dy = boundEntity.pos.y - maybeShip.pos.y;
    const dz = boundEntity.pos.z - maybeShip.pos.z;
    if (dx * dx + dy * dy + dz * dz > SELL_TERMINAL_RANGE_SQ_M) {
      return {
        ok: false,
        code: "not-at-station",
        message: `Character too far from dock terminal (max ${SELL_TERMINAL_RANGE_M} m)`,
      };
    }
    dockShip = maybeShip;
  } else {
    return {
      ok: false,
      code: "not-at-station",
      message: `Unsupported entity kind for dock-sell: ${boundEntity.kind}`,
    };
  }

  // Defensive: the source override should match the entity kind.
  if (args.source !== undefined && args.source !== source) {
    return {
      ok: false,
      code: "invalid-amount",
      message: `Source mismatch: entity is ${source === "hold" ? "in-ship" : "on-foot"}, but source=${args.source}`,
    };
  }

  // Defensive: the dock-ship reference must exist.
  if (dockShip === null) {
    return { ok: false, code: "not-found", message: "Dock ship reference lost mid-handler" };
  }
  const persistentShipId = dockShip.id.replace(/^entity:/u, "");

  // ---- read both shapes from the DB ----------------------------------
  // The reads happen outside the credit transaction so we have the
  // full picture before we mutate anything. Better-sqlite3
  // serialises writes at the driver layer, so any concurrent
  // inventory / cargo mutation either commits before our read or
  // is observed in our read; there is no partial-state window
  // visible to this handler.
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
    const shipRow = await repo.findShipById(persistentShipId);
    if (!shipRow) {
      return { ok: false, code: "not-found", message: `Ship ${persistentShipId} not found` };
    }
    if (!validateCargoHold(shipRow.cargo)) {
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

  // ---- compute the new shapes ---------------------------------------
  const sourceStacks = source === "hold" ? cargo.stacks : inventory.stacks;
  const sellResult = sellStack({
    stacks: sourceStacks,
    id: resourceType,
    amount: args.amount,
  });
  if (sellResult.sold <= 0 || sellResult.remaining > 0) {
    // Either unknown-resource (defensive — already checked
    // above), invalid-amount, or insufficient (request > stack).
    // The dock-sell spec calls out `insufficient` as the
    // structured code when the request exceeds the source's
    // available amount — partial sales are NOT supported at the
    // dock (a player who wants to sell 10 of 2 just gets the
    // rejection so the UI can surface the toast).
    const owned = sourceStacks[resourceType] ?? 0;
    return {
      ok: false,
      code: "insufficient",
      message: `Cannot sell ${args.amount} ${resourceType}; only ${owned} in ${source}`,
    };
  }

  const earned = sellResult.earned;

  const newCargo: CargoHold =
    source === "hold"
      ? {
          stacks: { ...sellResult.stacks },
          weightUsed: recomputeCargoWeightAfterSell({
            stacks: { ...sellResult.stacks },
            weightUsed: 0,
            capacity: cargo.capacity,
          }),
          capacity: cargo.capacity,
        }
      : cargo;
  const newInventory: Inventory =
    source === "inv"
      ? {
          stacks: { ...sellResult.stacks },
          weightUsed: recomputeInventoryWeightAfterSell({
            stacks: { ...sellResult.stacks },
            weightUsed: 0,
          }),
        }
      : inventory;

  // Validate the new shapes (defensive — recompute should never
  // fail but a buggy helper shouldn't propagate garbage to the DB).
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

  // ---- persist credit + stack -----------------------------------------
  // The credit add is atomic on its own via TASK-41's compare-and-
  // swap guard (`SET credits = credits + ?` runs against a single
  // SQLite write; better-sqlite3 serialises writes at the driver
  // layer so concurrent `addCredits` calls cannot lose updates).
  // The stack write happens immediately after — same v1 trade-off
  // as TASK-39 cargo transfer (a crash window between the two
  // writes is bounded and the spec accepts it). Both writes
  // complete BEFORE the `sell_ok` ack so the client never sees a
  // transient shape that contradicts the durable state.
  let newBalance: number;
  try {
    const updated = await repo.addCredits(conn.playerId, earned);
    newBalance = updated.credits;
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { ok: false, code: "not-found", message: err.message };
    }
    throw err;
  }

  // Persist the new stack shape AFTER the credit commit. A crash
  // window between the two leaves the credit added but the stack
  // not yet debited; the next sell would re-debit (the source
  // stack would still be at the old amount) and the player would
  // receive double credit. We accept this trade-off per the v1
  // spec ("no infinite recovery for v1").
  if (source === "hold") {
    await repo.saveShipState(persistentShipId, { cargo: newCargo });
    if (dockShip.cargo) {
      dockShip.cargo = newCargo;
    }
  } else {
    await repo.saveInventory(conn.playerId, newInventory);
  }

  return {
    ok: true,
    source,
    resourceType,
    requested: args.amount,
    sold: sellResult.sold,
    earned,
    newBalance,
    cargo: newCargo,
    inventory: newInventory,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the entity the connection is currently driving. Returns
 * `null` when no entity is bound (mid-handshake) so callers reject
 * with `not-at-station`.
 */
function resolveBoundEntity(conn: ShardConnection, shard: Shard): SimEntity | null {
  if (conn.entityId === null) return null;
  const entity = shard.entities.get(conn.entityId);
  return entity ?? null;
}

// Re-export so the route layer + tests can use the price helper.
export { priceFor };

// Internal: keep the resource-type narrowing consistent across
// both the WS handler and the REST route. The route's zod parse
// already drops invalid ids, but the WS handler uses raw `string`
// (the protocol's free-form resource field) and benefits from
// the same `isSellableResourceType` guard.

// Type-only re-export for the route layer / tests.
export type { CargoResourceType };
export { INVENTORY_WEIGHT_PER_UNIT, CARGO_WEIGHT_PER_UNIT };
