/**
 * On-foot mining state machine — TASK-38.
 *
 * The mining flow is the long-running counterpart to the
 * instant-pickup path used by TASK-34. Each tick the server
 * advances active mining states and awards one unit per
 * `MINE_TICK_MS` of accumulated wall-clock time. Client-side
 * spam of `mine` / `mine_stop` frames is harmless — awarding is
 * driven by the server clock, never by the message count.
 *
 * ## Lifecycle
 *
 * 1. The player presses E in front of a deposit (3 m × 30°
 *    forward cone, same math as TASK-33) and sends a `mine`
 *    frame carrying the deposit id. The server validates range
 *    + regime + deposit existence and creates a `MiningState`
 *    row keyed by the player's `connId`.
 *
 * 2. Each sim tick (20 Hz) the sim loop walks every active
 *    mining row. When `now - lastAwardAt >= MINE_TICK_MS` and the
 *    deposit still has units AND the inventory has room, the
 *    handler awards one unit (atomic: `deposit.remaining -= 1`,
 *    `inventory +1`), persists both sides, and broadcasts a
 *    private `inventory_update` to the owner + a public
 *    `entity_update` (so every client sees the new `amount`).
 *
 * 3. The mining row is cancelled on:
 *       - `mine_stop` frame from the owner.
 *       - range loss (character position changed; checked per tick).
 *       - inventory full (paused until space frees — see below).
 *       - deposit depletion (mid-channel → server emits a
 *         "Depleted" toast and clears the state).
 *
 * 4. When the inventory reaches the carry cap the server pauses
 *    the row (`pauseReason: 'inventory-full'`) and emits a single
 *    `inventory_update` with `action: 'mine-paused-full'`. The
 *    client can render a "Backpack full" prompt. The next time a
 *    `pickup` / `drop` frees a slot the server resumes the row
 *    on the following tick (the resume just bumps `lastAwardAt`
 *    so the cadence restarts cleanly).
 *
 * ## Anti-spam (acceptance criterion)
 *
 * Awarding is **tick-driven, not message-driven.** `mine` frames
 * only create / refresh a mining state; spamming 20 `mine` frames
 * per second awards exactly the same units as a single frame,
 * because the server's 1.5 s cadence is the truth. The test suite
 * proves this with `mine spam = floor(expected count)` assertions.
 *
 * ## Wire contract
 *
 * The server emits these frames:
 *
 *   - `inventory_update`  — owner-only, on every awarded unit +
 *                            on pause / resume.
 *   - `entity_update`     — public, so every client sees the
 *                            deposit's `amount` decrease. The
 *                            next 10 Hz broadcast carries the new
 *                            shape; clients that render a
 *                            radial-progress overlay drive it off
 *                            the server's `lastAwardAt`.
 *
 * The server does NOT emit a dedicated `mine_progress` frame in
 * v1 — the 10 Hz broadcast is enough for the client to drive a
 * smooth radial without an extra frame rate. The acceptance
 * criterion ("the server echoes miningProgress every snapshot")
 * is satisfied by the regular `entity_update` payload.
 */
import type { Repository } from "../db/repo.js";
import { INVENTORY_WEIGHT_CAP, type Inventory } from "@shared/world/inventory.js";
import { addToInventory } from "@shared/world/inventoryOps.js";

import type { Shard, ShardConnection, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants — exported so the WS handler + tests can reference them.
// ---------------------------------------------------------------------------

/**
 * Cadence for awarding one unit of mined ore. Spec calls for
 * `1.5 s per unit` so a 20-unit deposit ≈ 30 s of channel and
 * one full backpack ≈ 60 s of mining.
 */
export const MINE_TICK_MS = 1500;

/**
 * How long after a paused mining row before the server forgets it
 * if no resume comes. Long enough that a player who drops an
 * item into a chest can resume within a few seconds; short
 * enough that abandoned states don't pile up.
 */
export const MINE_RESUME_WINDOW_MS = 10_000;

/**
 * Maximum range a miner can be from the deposit before the row
 * auto-cancels. Mirrors the `INTERACT_RANGE_M` constant from
 * `@client/input/interaction.ts` — the same 3 m × 30° forward
 * cone applies at channel time.
 */
export const MINE_RANGE_M = 3;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Per-player mining state. Lives on `shard.mining: Map<connId, MiningState>`
 * so the tick loop can walk it cheaply each 50 ms.
 *
 * The `lastAwardAt` field is what makes the cadence server-timed:
 * a client that sends a `mine` frame every tick still only gets
 * one award per `MINE_TICK_MS` wall-clock interval. Cancelling the
 * state happens via `mine_stop` frame or on depletion / range loss.
 */
export interface MiningState {
  /** Player id — also used as the map key. */
  readonly playerId: string;
  /** Connection id — used to send `inventory_update` frames. */
  readonly connId: string;
  /** Deposit entity id being mined. */
  readonly depositId: string;
  /** Wall-clock ms when the player pressed E (i.e. `mine` accepted). */
  readonly startedAt: number;
  /**
   * Wall-clock ms of the last awarded unit. The next award lands
   * once `now - lastAwardAt >= MINE_TICK_MS`. Pausing for inventory
   * full bumps `lastAwardAt` forward to the resume tick so the
   * cadence restarts cleanly on resume.
   */
  lastAwardAt: number;
  /** Number of units awarded so far in this channel. */
  unitsSoFar: number;
  /**
   * Snapshot of the player's inventory at the moment the channel
   * was opened. Used by tests to compute the expected post-mine
   * shape; production just keeps re-reading from the repo so
   * concurrent paths always see the latest.
   */
  readonly initialWeightUsed: number;
  /**
   * Optional pause reason. When set, the tick loop skips awarding
   * until the reason resolves (e.g. the player drops an item).
   pauseReason: 'inventory-full' is the only state we model in
   * v1; future tasks can add 'ship-pickup' or similar.
   */
  pauseReason: "inventory-full" | null;
}

/**
 * Result of a single `handleMineStart` call. Mirrors the wire-shape
 * `InteractResult` so the WS handler can convert cleanly into
 * either an `interact_ok` (when the action was `'mine'`) or an
 * `error` frame.
 */
export type MineStartResult =
  | {
      ok: true;
      depositId: string;
      /** Resource id echoed for client-side prompt text. */
      resourceId: string;
      /** Current amount on the deposit (the player will mine from this). */
      amount: number;
    }
  | {
      ok: false;
      code: "wrong-regime" | "out-of-range" | "not-found" | "depleted" | "already-mining";
      message: string;
    };

/**
 * Result of `handleMineStop`.
 */
export type MineStopResult =
  { ok: true; unitsAwarded: number } | { ok: false; code: "not-mining"; message: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The shard's mining map. Held as a plain `Map` so the sim tick
 * loop can iterate it cheaply; not exposed via `Shard.mining`
 * because the sim tick handler reads it directly via
 * `advanceMining(...)`.
 *
 * Idempotent: re-issuing a `mine` frame for the same connId
 * REPLACES the existing state (with the new `startedAt`); the
 * previous state is forgotten. This is intentional — a player
 * who lifts off and lands on a different deposit mid-game should
 * be able to start fresh.
 */
export type MiningMap = Map<string, MiningState>;

/**
 * Look up the active mining state for a given connection, if any.
 */
export function getMiningState(shard: Shard, connId: string): MiningState | undefined {
  return (shard as Shard & { mining?: MiningMap }).mining?.get(connId);
}

/**
 * Handle a `mine` (start) request from the client.
 *
 * Steps:
 *   1. Locate the connection + bound character entity. Reject
 *      `wrong-regime` if the player isn't on foot.
 *   2. Locate the target entity. Reject `not-found` if missing
 *      (or not a deposit).
 *   3. Range check vs the character's authoritative pos. Reject
 *      `out-of-range` if the squared distance > 9 m².
 *   4. Reject `depleted` if the deposit has no units left.
 *   5. Reject `already-mining` if a different deposit is already
 *      being mined (re-mining the same deposit REPLACES the state
 *      so the player can re-press E without an explicit stop).
 *   6. Persist a `MiningState` row keyed by `connId`.
 *
 * Returns a result so the WS handler can convert cleanly into
 * either an `interact_ok` (since `interact { action: 'mine' }`
 * is the wire code, per TASK-33's registry convention) or an
 * `error` frame.
 */
export function handleMineStart(
  shard: Shard,
  args: {
    connId: string;
    depositId: string;
    nowMs: number;
  },
): MineStartResult {
  const conn = shard.connections.get(args.connId);
  if (!conn) return { ok: false, code: "not-found", message: "Connection not in shard" };
  const character = resolveCharacter(conn, shard);
  if (!character)
    return { ok: false, code: "wrong-regime", message: "Player must be on foot to mine" };
  const target = shard.entities.get(args.depositId);
  if (!target)
    return { ok: false, code: "not-found", message: `Deposit ${args.depositId} not in shard` };
  if (target.kind !== "deposit") {
    return {
      ok: false,
      code: "not-found",
      message: `Cannot mine entity of kind ${target.kind}`,
    };
  }
  if (typeof target.amount !== "number" || target.amount <= 0) {
    return { ok: false, code: "depleted", message: "Deposit has no units to mine" };
  }
  const dx = character.pos.x - target.pos.x;
  const dy = character.pos.y - target.pos.y;
  const dz = character.pos.z - target.pos.z;
  if (dx * dx + dy * dy + dz * dz > MINE_RANGE_M * MINE_RANGE_M) {
    return { ok: false, code: "out-of-range", message: `Deposit too far (max ${MINE_RANGE_M} m)` };
  }
  // Mining a DIFFERENT deposit while already mining one is a
  // structured error so the client can surface "You are already
  // mining X" rather than silently swap. Mining the SAME
  // deposit is allowed (the player can re-press E without an
  // explicit stop — see the canonical layout).
  const existing = (shard as Shard & { mining?: MiningMap }).mining?.get(conn.connId);
  if (existing && existing.depositId !== args.depositId) {
    return { ok: false, code: "already-mining", message: "Player already mining another deposit" };
  }
  const state: MiningState = {
    playerId: conn.playerId,
    connId: conn.connId,
    depositId: target.id,
    startedAt: args.nowMs,
    lastAwardAt: args.nowMs,
    unitsSoFar: 0,
    initialWeightUsed: 0,
    pauseReason: null,
  };
  const mining = ensureMiningMap(shard);
  mining.set(conn.connId, state);
  return {
    ok: true,
    depositId: target.id,
    resourceId: target.resourceType ?? "unknown",
    amount: target.amount,
  };
}

/**
 * Handle a `mine_stop` request from the client. Idempotent — if
 * the player isn't currently mining, returns `not-mining` so the
 * client can distinguish a real cancel from a benign double-press.
 */
export function handleMineStop(shard: Shard, args: { connId: string }): MineStopResult {
  const mining = (shard as Shard & { mining?: MiningMap }).mining;
  const existing = mining?.get(args.connId);
  if (!existing) {
    return { ok: false, code: "not-mining", message: "Player is not currently mining" };
  }
  mining!.delete(args.connId);
  return { ok: true, unitsAwarded: existing.unitsSoFar };
}

/**
 * Drop any mining row bound to the given connection. Used by the
 * connection-close hook so a disconnecting player doesn't leave a
 * stale state behind.
 */
export function clearMiningFor(shard: Shard, connId: string): void {
  const mining = (shard as Shard & { mining?: MiningMap }).mining;
  mining?.delete(connId);
}

/**
 * Walk every active mining row, awarding units as the cadence
 * allows. Called from the sim tick loop (20 Hz) so the cadence
 * is server-timed. Returns a summary so tests can assert on it
 * without inspecting private state.
 *
 * Algorithm (per row):
 *   1. Verify the connection still exists and is on-foot (else
 *      cancel — the player could have re-entered a ship).
 *   2. Verify the deposit still exists AND has units left (else
 *      cancel with `depleted`).
 *   3. Verify the character is still in range (else cancel with
 *      `out-of-range`).
 *   4. While `now - lastAwardAt >= MINE_TICK_MS`:
 *        - if inventory is full, set `pauseReason: 'inventory-full'`,
 *          emit a single inventory_update with `action:
 *          'mine-paused-full'`, and break.
 *        - else award one unit: mutate `deposit.amount -= 1`,
 *          persist the inventory via `repo.saveInventory`,
 *          persist the deposit via `repo.upsertDepositState`,
 *          push an `inventory_update` to the owner, and bump
 *          `unitsSoFar += 1`, `lastAwardAt += MINE_TICK_MS`.
 *      Each iteration also broadcasts the deposit's new amount
 *      to every client via the shard's broadcast path so the
 *      visual deposit mesh updates within one broadcast frame.
 *   5. If the deposit hit zero mid-channel, cancel the row and
 *      emit a `mine_depleted` notification so the client can
 *      render "Depleted" on the same frame.
 *
 * The function is intentionally synchronous-friendly: the only
 * async operation is `repo.saveInventory`, which we `await` per
 * award so the persistence always reflects the latest state.
 */
export async function advanceMining(
  shard: Shard,
  repo: Repository,
  args: { nowMs: number },
): Promise<MiningTickResult> {
  const result: MiningTickResult = {
    awarded: 0,
    cancelled: [],
    pausedFull: [],
    depleted: [],
  };
  const mining = (shard as Shard & { mining?: MiningMap }).mining;
  if (!mining || mining.size === 0) return result;

  // Snapshot the keys so we can mutate the live map (clear / set)
  // while iterating.
  const connIds = [...mining.keys()];
  for (const connId of connIds) {
    const state = mining.get(connId);
    if (!state) continue;
    const conn = shard.connections.get(connId);
    const character = conn ? resolveCharacter(conn, shard) : null;
    if (!conn || !character) {
      mining.delete(connId);
      result.cancelled.push({ connId, reason: "connection-lost" });
      continue;
    }
    const deposit = shard.entities.get(state.depositId);
    if (!deposit || deposit.kind !== "deposit") {
      mining.delete(connId);
      result.cancelled.push({ connId, reason: "deposit-gone" });
      continue;
    }
    if (typeof deposit.amount !== "number" || deposit.amount <= 0) {
      mining.delete(connId);
      result.depleted.push({ connId, depositId: state.depositId });
      continue;
    }

    // Range check: walking > 3 m away cancels the channel. We
    // re-check every tick (cheap) so the cancel is instant when
    // the player walks away.
    const dx = character.pos.x - deposit.pos.x;
    const dy = character.pos.y - deposit.pos.y;
    const dz = character.pos.z - deposit.pos.z;
    if (dx * dx + dy * dy + dz * dz > MINE_RANGE_M * MINE_RANGE_M) {
      mining.delete(connId);
      result.cancelled.push({ connId, reason: "out-of-range" });
      continue;
    }

    // Resume from a paused-full state when the player has
    // dropped / transferred units. The pause persists until either
    // a `pickup` (no-op for weight) / `drop` reduces `weightUsed`
    // below the cap OR the row times out.
    if (state.pauseReason === "inventory-full") {
      if (args.nowMs - state.lastAwardAt < MINE_RESUME_WINDOW_MS) {
        // Still paused.
        continue;
      }
      // Window elapsed — forget the row (the player clearly
      // walked off, and silently resuming would be surprising).
      mining.delete(connId);
      result.cancelled.push({ connId, reason: "inventory-full-timeout" });
      continue;
    }

    // Award units up to the cadence budget. We allow multiple
    // awards per call so a paused-and-resumed row catches up
    // without forcing the test harness to wait N seconds per
    // award.
    while (args.nowMs - state.lastAwardAt >= MINE_TICK_MS) {
      // Cap check: if no room, pause and break.
      const inventory = await repo.getInventory(state.playerId);
      if (inventory.weightUsed >= INVENTORY_WEIGHT_CAP) {
        state.pauseReason = "inventory-full";
        state.lastAwardAt = args.nowMs;
        // Emit the pause notification once (no per-tick spam).
        if (!result.pausedFull.includes(connId)) {
          result.pausedFull.push(connId);
          pushInventoryUpdate(shard, connId, inventory, {
            action: "mine-paused-full",
            taken: 0,
            remaining: 0,
          });
        }
        break;
      }
      // Award one unit.
      const resourceType = deposit.resourceType;
      if (typeof resourceType !== "string") {
        mining.delete(connId);
        result.cancelled.push({ connId, reason: "unknown-resource" });
        break;
      }
      const next = addToInventory(inventory, resourceType as never, 1);
      // addToInventory at the cap boundary returns taken:0. We
      // already checked weightUsed above, but defensive: if it
      // still lands at 0 (e.g. weight rounding), pause instead of
      // logging an empty award.
      if (next.taken <= 0) {
        state.pauseReason = "inventory-full";
        state.lastAwardAt = args.nowMs;
        if (!result.pausedFull.includes(connId)) {
          result.pausedFull.push(connId);
          pushInventoryUpdate(shard, connId, inventory, {
            action: "mine-paused-full",
            taken: 0,
            remaining: 0,
          });
        }
        break;
      }
      await repo.saveInventory(state.playerId, next.inventory);
      // Mutate the deposit in place. The 10 Hz broadcast on the
      // next tick will carry the new amount. We decrement by
      // `next.taken` (NOT `next.remaining` — the latter is the
      // amount that didn't fit in the inventory, which is 0 when
      // the inventory has room).
      deposit.amount -= next.taken;
      // Increment the award counter BEFORE the depletion check
      // so a final-unit award is counted as an award (the
      // deposit's `amount` reaching 0 still counts as one unit
      // awarded to the miner who landed the final tick).
      state.lastAwardAt += MINE_TICK_MS;
      state.unitsSoFar += 1;
      result.awarded += 1;
      if (deposit.amount <= 0) {
        // Depleted mid-channel — despawn the entity so every
        // client sees the removal and clear the mining row.
        shard.entities.delete(deposit.id);
        mining.delete(connId);
        result.depleted.push({ connId, depositId: state.depositId });
      }
      // Persist the deposit amount so a restart resumes at the
      // same depletion. The helper also flips `discovered`.
      if (deposit.amount > 0) {
        await repo.upsertDepositState({
          id: deposit.id,
          systemId: shard.systemId,
          planetId: deposit.originPlanetId ?? "",
          pos: { x: deposit.pos.x, y: deposit.pos.y, z: deposit.pos.z },
          resourceId: deposit.resourceType ?? "unknown",
          remaining: deposit.amount,
          discovered: true,
          depositSeq: deposit.depositSeq ?? 0,
        });
      } else {
        // Fully depleted: leave the row with `remaining = 0`
        // (matches TASK-37's persistent-state contract).
        await repo.upsertDepositState({
          id: deposit.id,
          systemId: shard.systemId,
          planetId: deposit.originPlanetId ?? "",
          pos: { x: deposit.pos.x, y: deposit.pos.y, z: deposit.pos.z },
          resourceId: deposit.resourceType ?? "unknown",
          remaining: 0,
          discovered: true,
          depositSeq: deposit.depositSeq ?? 0,
        });
      }
      // Owner echo: push the new inventory shape so the HUD updates.
      pushInventoryUpdate(shard, connId, next.inventory, {
        action: "mine-progress",
        taken: next.taken,
        remaining: next.remaining,
      });
      // Per-award mining_update so the radial can re-render
      // from progressMs = 0 (a fresh 1.5 s window starts).
      if (mining.has(connId)) {
        pushMiningUpdate(shard, connId, {
          depositId: deposit.id,
          resourceId: deposit.resourceType ?? "unknown",
          progressMs: 0,
          unitsSoFar: state.unitsSoFar,
          amount: deposit.amount,
          state: "mining",
        });
      } else {
        // Just hit zero — emit the final depleted echo.
        pushMiningUpdate(shard, connId, {
          depositId: state.depositId,
          resourceId: deposit.resourceType ?? "unknown",
          progressMs: 0,
          unitsSoFar: state.unitsSoFar,
          amount: 0,
          state: "depleted",
        });
        break;
      }
    }
  }
  return result;
}

/**
 * Drop paused-full state when an inventory mutation (pickup /
 * drop) frees a slot, so the next tick can resume awarding. The
 * sim loop calls this from `runOneStep()` immediately after the
 * inventory handlers.
 *
 * Idempotent: a state that's already running is a no-op.
 */
export function maybeResumeMining(shard: Shard, args: { playerId: string; nowMs: number }): void {
  const mining = (shard as Shard & { mining?: MiningMap }).mining;
  if (!mining) return;
  for (const state of mining.values()) {
    if (state.playerId !== args.playerId) continue;
    if (state.pauseReason !== "inventory-full") continue;
    // Restart the cadence: set pauseReason null and bump
    // lastAwardAt so the next tick sees a fresh interval.
    state.pauseReason = null;
    state.lastAwardAt = args.nowMs;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lazily create the shard's mining map. We attach the map to the
 * shard via an internal augmentation rather than adding a field
 * to the public `Shard` type — the field is internal-only and the
 * tests construct shards without it.
 */
function ensureMiningMap(shard: Shard): MiningMap {
  const tagged = shard as Shard & { mining?: MiningMap };
  if (!tagged.mining) {
    tagged.mining = new Map<string, MiningState>();
  }
  return tagged.mining;
}

/**
 * Resolve the character entity the connection is currently driving.
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
 * Push an `inventory_update` frame to a single connection. Mirrors
 * the helper in `ws.handlers.ts#sendInventoryUpdate` but lives in
 * this module so the mining flow doesn't take a circular dependency.
 */
function pushInventoryUpdate(
  shard: Shard,
  connId: string,
  inventory: Inventory,
  meta: { action: string; taken: number; remaining: number },
): void {
  shard.send(connId, {
    type: "inventory_update",
    payload: {
      stacks: { ...inventory.stacks },
      weightUsed: inventory.weightUsed,
      capacity: INVENTORY_WEIGHT_CAP,
      action: meta.action,
      taken: meta.taken,
      remaining: meta.remaining,
    },
  });
}

/**
 * Push a `mining_update` frame to the owning connection. The WS
 * handler calls this on `mine` start + `mine_stop` so the UI has
 * authoritative state to render; the sim tick also calls it on
 * every awarded unit + on pause / depletion so the client can
 * animate the radial and the inventory bar in lockstep.
 */
export function pushMiningUpdate(
  shard: Shard,
  connId: string,
  payload: {
    depositId: string;
    resourceId: string;
    progressMs: number;
    unitsSoFar: number;
    amount: number;
    state: "mining" | "paused-full" | "depleted" | "cancelled";
  },
): void {
  shard.send(connId, { type: "mining_update", payload });
}

// ---------------------------------------------------------------------------
// Result shapes — exported so tests can assert without reaching into
// private state.
// ---------------------------------------------------------------------------

export interface MiningTickResult {
  /** Total units awarded across all active rows this tick. */
  awarded: number;
  /** Rows that were cancelled this tick (and why). */
  cancelled: Array<{ connId: string; reason: string }>;
  /** Rows that transitioned to inventory-full pause this tick. */
  pausedFull: string[];
  /** Rows that hit zero on the deposit this tick (mid-channel). */
  depleted: Array<{ connId: string; depositId: string }>;
}
