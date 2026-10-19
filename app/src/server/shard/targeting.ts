/**
 * Targeting lock state — TASK-44 server-authoritative layer.
 *
 * The server is the single source of truth for who has whom locked.
 * Three responsibilities:
 *
 *   1. **Validation** — `handleTargetLock({ targetId })` rejects
 *      invalid requests (out of range, outside the nose cone, not a
 *      ship, already destroyed) with the `invalid-target` wire code.
 *      `handleTargetRelease()` releases whatever the connection has
 *      locked.
 *   2. **Auto-release** — every sim tick `advanceTargetLocks(shard,
 *      nowMs)` walks the lock map and releases any lock whose target
 *      died, exited `TARGET_LOCK_AUTO_RELEASE_RANGE_M`, or whose
 *      `lockedAt + TARGET_LOCK_DURATION_MS` has elapsed. Releases
 *      push `target_released` to the owning connection.
 *   3. **Targeting-state broadcast** — `pushTargetUpdate(shard,
 *      connId, nowMs)` feeds the locking client's `target_update`
 *      frame every snapshot (the spec: "live, updated per
 *      snapshot"). `releaseBroadcastTargeted` broadcasts the
 *      `targetedBy` icon update so the targeted ship (and everyone
 *      else) sees the lock indicator.
 *
 * The missile-preference path lives in `weapons.ts:fireMissile` —
 * this module owns the lock state, the weapons module consults it.
 *
 * @see ./weapons.ts for `fireMissile`'s read of the lock.
 * @see ./entity.ts for the `targetedBy` wire field.
 * @see ./sim.ts for the per-tick `advanceTargetLocks` call.
 * @see ./index.ts for the `targets` map wiring.
 */

import {
  TARGET_LOCK_AUTO_RELEASE_RANGE_M,
  TARGET_LOCK_DURATION_MS,
  TARGET_LOCK_RANGE_M,
  bearingDegrees,
  distanceM,
  isLockableTarget,
} from "@shared/targeting.js";

import { entityToWire } from "./entity.js";
import type { SimEntity, Shard, ShardTargetLock } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discriminated result of `handleTargetLock`. Mirrors the wire-level
 * outcome:
 *   - `'locked'`    — server accepted; lock state mutated.
 *   - `'released'`  — toggle: caller already had this target locked,
 *                     server cleared the lock.
 *   - `'invalid'`   — out of range / not a ship / outside cone /
 *                     already destroyed → caller surfaces
 *                     `invalid-target`.
 */
export type HandleTargetLockResult =
  | { kind: "locked"; targetId: string; target: SimEntity }
  | { kind: "released"; targetId: string }
  | { kind: "invalid"; reason: HandleTargetLockInvalidReason };

export type HandleTargetLockInvalidReason =
  "not-found" | "not-a-ship" | "out-of-range" | "line-of-sight" | "destroyed" | "self-target";

/**
 * Lock `connId → targetId` on `shard.targets`.
 *
 * Idempotent for the "toggle" path: when `args.targetId` matches the
 * connection's existing lock, the lock is released (TASK-44
 * acceptance: "re-pressing T on an already-locked target releases
 * it (toggle)"). When `args.targetId === null` and the connection has
 * no lock, the function returns `{ kind: 'invalid', reason:
 * 'not-found' }` so the wire stays symmetrical with the "release
 * frame has no lock" case.
 *
 * On accept the function:
 *   1. Reads the conn's entity + the candidate target.
 *   2. Validates the candidate against the lock range + cone + kind
 *      gates (`isLockableTarget`).
 *   3. Records the lock on `shard.targets` and pushes
 *      `target_locked` + a fresh `target_update` to the requesting
 *      connection.
 *   4. Broadcasts the targeted ship's new `targetedBy` list to every
 *      connection in the shard (the lock icon update).
 */
export function handleTargetLock(args: {
  shard: Shard;
  connId: string;
  targetId: string | null;
  nowMs?: number;
}): HandleTargetLockResult {
  const now = args.nowMs ?? Date.now();
  const conn = args.shard.connections.get(args.connId);
  if (!conn) return { kind: "invalid", reason: "not-found" };
  const ship = args.shard.entities.get(conn.entityId ?? "");
  if (!ship || (ship.kind !== "player" && ship.kind !== "ai")) {
    return { kind: "invalid", reason: "not-found" };
  }

  // Toggle path: caller has an active lock on the requested target.
  if (args.targetId !== null) {
    const existing = args.shard.targets.get(conn.connId);
    if (existing && existing.targetId === args.targetId) {
      releaseLockFor({
        shard: args.shard,
        connId: conn.connId,
        reason: "toggle",
        nowMs: now,
      });
      return { kind: "released", targetId: args.targetId };
    }
  }

  // Release-all path: `targetId === null` releases whatever's locked.
  if (args.targetId === null) {
    const existing = args.shard.targets.get(conn.connId);
    if (!existing) return { kind: "invalid", reason: "not-found" };
    releaseLockFor({
      shard: args.shard,
      connId: conn.connId,
      reason: "manual",
      nowMs: now,
    });
    return { kind: "released", targetId: existing.targetId };
  }

  // Validate the candidate.
  const target = args.shard.entities.get(args.targetId);
  if (!target) return { kind: "invalid", reason: "not-found" };
  if (target.id === ship.id) return { kind: "invalid", reason: "self-target" };
  if (target.kind !== "player" && target.kind !== "ai") {
    return { kind: "invalid", reason: "not-a-ship" };
  }
  if (target.hull <= 0) return { kind: "invalid", reason: "destroyed" };
  if (!isLockableTarget(ship, target)) {
    // Range / cone gate failed. Disambiguate the wire reason by
    // running each gate independently — the invalid-target code is
    // opaque to the client, but the server logs benefit.
    const inLockRange = distanceM(ship, target) <= TARGET_LOCK_RANGE_M;
    // (The cone check is the inverse of `isLockableTarget` here —
    // we know `isLockableTarget` returned false AND the target is a
    // live ship, so it's either range or cone.)
    return {
      kind: "invalid",
      reason: inLockRange ? "line-of-sight" : "out-of-range",
    };
  }

  // Commit. Capture any prior lock so we can release the previous
  // `targetedBy` broadcast before stamping the new one.
  const previous = args.shard.targets.get(conn.connId);
  args.shard.targets.set(conn.connId, { targetId: target.id, lockedAt: now });

  // Push the success ack to the locking player.
  pushTargetLockedAck(args.shard, conn.connId, {
    targetId: target.id,
    target,
    ship,
    nowMs: now,
  });
  // First `target_update` so the box renders immediately on the
  // accepting client.
  pushTargetUpdate(args.shard, conn.connId, ship, target, now);

  // Broadcast the `targetedBy` icon update. We always recompute both
  // ends so the previous target's icon drops too.
  const stale = previous?.targetId;
  broadcastTargetedByUpdate(args.shard, target.id, stale);
  return { kind: "locked", targetId: target.id, target };
}

/**
 * Release whatever the connection has locked. The lock state may be
 * `undefined` (no active lock) — that's a no-op.
 *
 * Primarily used by `handleTargetRelease` and the auto-release tick.
 * For the wire-level release path see `releaseBroadcastTargeted`.
 */
export function handleTargetRelease(args: { shard: Shard; connId: string; nowMs?: number }): {
  released: string | null;
} {
  const now = args.nowMs ?? Date.now();
  const conn = args.shard.connections.get(args.connId);
  if (!conn) return { released: null };
  return releaseLockFor({
    shard: args.shard,
    connId: conn.connId,
    reason: "manual",
    nowMs: now,
  });
}

/**
 * Drop any connection entry (called on disconnect so the lock state
 * doesn't outlive the player's session). The targeted ship's
 * `targetedBy` icon list is recomputed so other players see the
 * indicator disappear.
 */
export function forgetConnectionLocks(shard: Shard, connId: string): void {
  const existing = shard.targets.get(connId);
  if (!existing) return;
  shard.targets.delete(connId);
  broadcastTargetedByUpdateFor(shard, existing.targetId);
}

/**
 * Walk every active lock once per sim tick. Releases any lock whose
 * target died, exited `TARGET_LOCK_AUTO_RELEASE_RANGE_M`, or whose
 * 30 s ceiling has elapsed. Returns the count of locks released for
 * diagnostics + tests.
 *
 * Called from `sim.ts#runOneStep` (after missile advancement, before
 * energy regen — cheap linear walk).
 */
export function advanceTargetLocks(
  shard: Shard,
  nowMs: number,
): {
  releasedDestroyed: number;
  releasedRange: number;
  releasedTimeout: number;
} {
  let releasedDestroyed = 0;
  let releasedRange = 0;
  let releasedTimeout = 0;
  if (shard.targets.size === 0) {
    return { releasedDestroyed, releasedRange, releasedTimeout };
  }
  // Snapshot the entry list so we can mutate mid-iteration.
  const entries: Array<[string, ShardTargetLock]> = [];
  for (const e of shard.targets.entries()) entries.push(e);
  for (const [connId, lock] of entries) {
    const target = shard.entities.get(lock.targetId);
    const conn = shard.connections.get(connId);
    const ship = conn?.entityId ? shard.entities.get(conn.entityId) : undefined;

    // No target (destroyed without a wreck — rare but possible) →
    // release as 'destroyed'.
    if (!target || target.hull <= 0) {
      releaseLockFor({
        shard,
        connId,
        reason: "destroyed",
        nowMs: nowMs,
      });
      releasedDestroyed += 1;
      continue;
    }

    // Player disconnected while holding a lock — release as a
    // plain range exit (the targeted ship's icon drops regardless
    // because `forgetConnectionLocks` would have run on the WS
    // close hook; this path is a defensive catch-up).
    if (!ship) {
      releaseLockFor({
        shard,
        connId,
        reason: "range-exceeded",
        nowMs: nowMs,
      });
      releasedRange += 1;
      continue;
    }

    // Range gate.
    const d = distanceM(ship, target);
    if (d > TARGET_LOCK_AUTO_RELEASE_RANGE_M) {
      releaseLockFor({
        shard,
        connId,
        reason: "range-exceeded",
        nowMs: nowMs,
      });
      releasedRange += 1;
      continue;
    }

    // Timeout gate.
    if (nowMs - lock.lockedAt >= TARGET_LOCK_DURATION_MS) {
      releaseLockFor({
        shard,
        connId,
        reason: "timeout",
        nowMs: nowMs,
      });
      releasedTimeout += 1;
      continue;
    }

    // Push a fresh `target_update` so the box's hull/shields/bearing
    // stay live.
    pushTargetUpdate(shard, connId, ship, target, nowMs);
  }
  return { releasedDestroyed, releasedRange, releasedTimeout };
}

/**
 * Push the current target's live stats to one connection. Called by
 * `advanceTargetLocks` and by the success-ack path so the box data is
 * refreshed on the same frame the lock is acquired.
 */
export function pushTargetUpdate(
  shard: Shard,
  connId: string,
  ship: SimEntity,
  target: SimEntity,
  nowMs: number,
): void {
  const bearing = bearingDegrees(ship, target);
  const range = distanceM(ship, target);
  shard.send(connId, {
    type: "target_update",
    payload: {
      targetId: target.id,
      shields: target.shields,
      hull: target.hull,
      bearing,
      range,
      callsign: target.callsign ?? null,
      classId: target.classId ?? null,
    },
  } as unknown as Parameters<typeof shard.send>[1]);
  void nowMs; // included for parity with auto-release tick path.
}

/**
 * Read-only: return the locked target entity for `connId`, or `null`
 * if the connection has no active lock (or the lock is stale).
 *
 * The weapons module's missile-preference path uses this helper so
 * it can fall back to "nearest in cone" / "straight" without having
 * to know the lock-map shape.
 */
export function lockFor(
  shard: Shard,
  connId: string,
): { lock: ShardTargetLock; target: SimEntity } | null {
  const lock = shard.targets.get(connId);
  if (!lock) return null;
  const target = shard.entities.get(lock.targetId);
  if (!target) return null;
  return { lock, target };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Internal: clear a single connection's lock and broadcast the icon
 * update. Returns the released target id (or `null` for the no-op
 * path).
 */
function releaseLockFor(args: {
  shard: Shard;
  connId: string;
  reason: "toggle" | "destroyed" | "range-exceeded" | "timeout" | "manual" | "snapshot";
  nowMs: number;
}): { released: string | null } {
  const existing = args.shard.targets.get(args.connId);
  if (!existing) return { released: null };
  args.shard.targets.delete(args.connId);

  // Push the release ack to the locking player (so the HUD can drop
  // the box). The function intentionally talks to the locking
  // player's connection only — other clients see the icon update
  // via the `targetedBy` broadcast below.
  try {
    args.shard.send(args.connId, {
      type: "target_released",
      payload: {
        targetId: existing.targetId,
        reason: args.reason,
      },
    } as unknown as Parameters<typeof args.shard.send>[1]);
  } catch {
    // swallow — broadcast is best-effort
  }

  broadcastTargetedByUpdateFor(args.shard, existing.targetId);
  return { released: existing.targetId };
}

/**
 * Internal: push the `target_locked` success ack + the first
 * `target_update` snapshot. Split out for testability.
 */
function pushTargetLockedAck(
  shard: Shard,
  connId: string,
  args: { targetId: string; target: SimEntity; ship: SimEntity; nowMs: number },
): void {
  const bearing = bearingDegrees(args.ship, args.target);
  const range = distanceM(args.ship, args.target);
  shard.send(connId, {
    type: "target_locked",
    payload: {
      targetId: args.targetId,
      callsign: args.target.callsign ?? null,
      range,
      bearing,
      lockedAt: args.nowMs,
    },
  } as unknown as Parameters<typeof shard.send>[1]);
}

/**
 * Broadcast the targeted ship's fresh `targetedBy` list. The lock
 * icon update flows through `entity_update` so every client in the
 * system sees the indicator appear / disappear on the same tick the
 * lock is acquired / released.
 *
 * Called from:
 *   - `handleTargetLock` (with both `added` and `removed` target ids
 *     so the previous target's icon drops cleanly),
 *   - `releaseLockFor` (a single target id).
 *
 * We rebuild the full `EntityState` for the affected ship rather than
 * pushing a tiny delta because the broadcast layer already speaks the
 * 10 Hz snapshot cadence — there's no benefit to a separate wire frame.
 */
function broadcastTargetedByUpdate(
  shard: Shard,
  addedTargetId: string,
  staleTargetId: string | undefined,
): void {
  broadcastTargetedByUpdateFor(shard, addedTargetId);
  if (staleTargetId && staleTargetId !== addedTargetId) {
    broadcastTargetedByUpdateFor(shard, staleTargetId);
  }
}

function broadcastTargetedByUpdateFor(shard: Shard, targetId: string): void {
  const target = shard.entities.get(targetId);
  if (!target) return;
  // Build the fresh list of conns that have THIS entity locked.
  const targetedBy: string[] = [];
  for (const [connId, lock] of shard.targets.entries()) {
    if (lock.targetId === targetId) targetedBy.push(connId);
  }
  // The snapshot serializer does the hard work; we only need the one
  // entity's wire shape. We invoke `entityToWire` directly so the wire
  // contract (callsign / classId / etc.) stays in lock-step with the
  // snapshot path.
  const wire = entityToWire(target);
  wire.targetedBy = targetedBy;

  // Walk every connection in the shard and send the targeted entity
  // in a tiny `entity_update` frame. We deliberately use a dedicated
  // per-connection send rather than `shard.broadcast` because the
  // snapshot router only fires every Nth tick — we want this icon
  // to land immediately.
  for (const conn of shard.connections.values()) {
    try {
      shard.send(conn.connId, {
        type: "entity_update",
        payload: {
          systemId: shard.systemId,
          tick: shard.sim.currentTick,
          entities: [wire],
          lastAppliedSeq: {},
        },
      } as unknown as Parameters<typeof shard.send>[1]);
    } catch {
      // swallow — best-effort broadcast
    }
  }
}
