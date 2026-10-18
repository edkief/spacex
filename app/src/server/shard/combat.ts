/**
 * Combat pipeline — TASK-23 keystone.
 *
 * This module wires the pure damage math in `@shared/physics/damage`
 * to the per-system shard:
 *
 *   - `applyCombatDamage(shard, args)` — the single entry point a
 *     weapon (TASK-43) or environmental hazard (TASK-48) calls when
 *     a hit lands. Reads the target's current HP, calls
 *     `applyDamage`, mutates the entity in place, and broadcasts a
 *     `combat_event` (`kind: 'damaged'`) to every connection in the
 *     shard. If the damage destroyed the ship, this function also
 *     spawns a wreck, swaps the destroyed entity for a wreck-like
 *     non-targetable state, and broadcasts `combat_event`
 *     (`kind: 'destroyed'`).
 *
 *   - `cleanupExpiredWrecks(shard, nowMs)` — called once per tick by
 *     `SimLoop`. Removes any `kind: 'wreck'` entity whose
 *     `wreckExpiresAt` has passed. Keeps the registry bounded at
 *     the 600 s spec ceiling (no persistent wreck registry in v1).
 *
 *   - `broadcastCombatEvent(shard, event)` — helper that pushes a
 *     `combat_event` frame to every connection in the shard via
 *     `shard.send`. The shard is transport-agnostic so this just
 *     walks `shard.connections`.
 *
 * Design pillars (carried over from TASK-13):
 *
 *   - **Single writer.** Entity mutations only happen on the tick
 *     thread. The combat helpers here are invoked by the tick loop
 *     after `runOneStep` for weapon hits, or by the message handler
 *     for direct combat events; they mutate `entity.hull` /
 *     `entity.shields` directly because the shard already owns the
 *     entity registry and the lock-free invariant is "mutate inside
 *     the tick or in a synchronous handler".
 *   - **Pure math outside, side effects inside.** The damage numbers
 *     are computed by `applyDamage` (pure). This module applies them.
 *   - **Double-destroy guard.** `applyCombatDamage` uses the
 *     `destroyed` flag in the result to de-dupe — a destroyed entity
 *     can't be re-destroyed, and the `destroyed` event fires at most
 *     once per death.
 *
 * @see ../shared/physics/damage.ts for the pure math.
 * @see ./types.ts for the entity + connection shapes.
 * @see ../../shared/protocol/schemas.ts for the `combat_event` wire
 *      shape (TASK-23 extends the schema with `damaged` + `destroyed`).
 */
import { applyDamage, type DamageTarget } from "@shared/physics/damage.js";
import type { DamageSource } from "@shared/physics/damage.js";
import type { ProtocolCombatEvent } from "@shared/protocol/index.js";

import { makeWreckEntity, makeWreckId } from "./entity.js";
import type { Shard, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Wreck TTL in seconds (TASK-23 spec: "removed after 600 s"). The
 * value is centralised here so a future tuning pass only has to flip
 * one knob. The cleanup loop uses ms-since-epoch timestamps, so the
 * constant carries its own unit suffix.
 */
export const WRECK_TTL_S = 600;

/** Wreck TTL expressed in milliseconds (cleanup loop granularity). */
export const WRECK_TTL_MS = WRECK_TTL_S * 1000;

// ---------------------------------------------------------------------------
// applyCombatDamage
// ---------------------------------------------------------------------------

/**
 * Apply `amount` damage to `targetId` on behalf of `source`. Returns
 * the same `ApplyDamageResult` as `applyDamage` plus the entity id of
 * any wreck that was spawned (null when the target survived).
 *
 *   - Mutates `entity.hull / entity.shields` in place.
 *   - On destruction, mutates the entity into a non-integrating
 *     state (kind stays "player" but `hull` is 0; the integration
 *     loop already skips `kind !== 'player'` would be wrong here —
 *     the player entity is intentionally *kept* so reconnect code
 *     (TASK-17) can find it). We *also* spawn a separate wreck
 *     entity with the destroyed ship's final position + orientation,
 *     which is what the renderer will draw.
 *   - Broadcasts a `combat_event` with `kind: 'damaged'` (always)
 *     and, if this call destroyed the target, a second
 *     `combat_event` with `kind: 'destroyed'`.
 *
 * The function is a no-op if the target does not exist on the shard
 * (returns `{shieldHit:0, hullHit:0, destroyed:false, ...,
 * wreckSpawnedId: null, destroyedTargetId: null, hit:false}`).
 * Callers should branch on the return shape, not on throw.
 */
export function applyCombatDamage(args: {
  shard: Shard;
  targetId: string;
  amount: number;
  source: DamageSource;
  /**
   * Tick number the damage occurred at. The wire `combat_event`
   * carries this so the HUD can correlate the impact animation
   * with the snapshot tick.
   */
  tick: number;
  /**
   * Wall-clock override used to compute the wreck TTL. Defaults to
   * `Date.now()`. Tests inject a fake clock.
   */
  nowMs?: number;
}): ApplyCombatDamageResult {
  const shard = args.shard;
  const entity = shard.entities.get(args.targetId);
  if (entity === undefined) {
    return EMPTY_RESULT;
  }

  // Already destroyed? The double-destroy guard is enforced by
  // `applyDamage` itself (returns `destroyed: true` with zero
  // `shieldHit / hullHit`); we still want to broadcast at most
  // one `destroyed` event per death, so we use the entity's hull
  // value as the gate.
  if (entity.hull <= 0) {
    return EMPTY_RESULT;
  }
  // TASK-31: characters don't take damage in v1 (no stamina /
  // shield model). Skip the damage pipeline entirely so an
  // accidental `applyCombatDamage` call against a character id
  // is a no-op rather than crashing on the null classId below.
  if (entity.kind === "character") {
    return EMPTY_RESULT;
  }

  const damageInput: {
    target: DamageTarget;
    classId: NonNullable<SimEntity["classId"]>;
    amount: number;
    source: DamageSource;
  } = {
    target: { hull: entity.hull, shields: entity.shields },
    // Cast: the character gate above proves `classId` is non-null
    // for any entity that reaches this point.
    classId: entity.classId as NonNullable<SimEntity["classId"]>,
    amount: args.amount,
    source: args.source,
  };

  const result = applyDamage(damageInput);

  // Apply the damage to the live entity in place.
  entity.hull = result.newHull;
  entity.shields = result.newShields;

  // Always broadcast the `damaged` event (the spec calls for "Damage
  // events ... broadcast as combat_event to the whole shard" for any
  // hit that wasn't a no-op).
  broadcastCombatEvent(shard, {
    kind: "damaged",
    target: entity.id,
    source: { kind: args.source.kind, id: args.source.id },
    amount: Math.max(result.shieldHit + result.hullHit, args.amount > 0 ? args.amount : 0),
    shieldHit: result.shieldHit,
    hullHit: result.hullHit,
    tick: args.tick,
  });

  if (!result.destroyed) {
    return {
      shieldHit: result.shieldHit,
      hullHit: result.hullHit,
      destroyed: false,
      newShields: result.newShields,
      newHull: result.newHull,
      hit: true,
      wreckSpawnedId: null,
      destroyedTargetId: null,
    };
  }

  // Destroyed: spawn a wreck at the entity's final position. The
  // wreck is a *separate* entity — the player entity is kept (so
  // reconnect code can still find the row), but its `hull` is 0,
  // `shields` is 0, and `vel` is zeroed. The connection's
  // `entityId` still points at the player entity; the integration
  // loop already gates on `kind === 'player'`, but `hull <= 0` is
  // an additional "non-targetable" gate we add in TASK-44.
  const now = args.nowMs ?? Date.now();
  const wreckId = makeWreckId(entity.id);
  const wreck = makeWreckEntity({
    id: wreckId,
    // Cast: the character gate above proves `classId` is non-null
    // for any entity that reaches this point (only ships get
    // wrecks — TASK-31 / TASK-49).
    classId: entity.classId as NonNullable<SimEntity["classId"]>,
    pos: entity.pos,
    quat: entity.quat,
    wreckExpiresAt: now + WRECK_TTL_MS,
  });
  shard.entities.set(wreckId, wreck);

  // Zero out the destroyed player's velocity so the broadcast
  // snapshot doesn't show a "ghost ship" still drifting with the
  // last-tick velocity.
  entity.vel.x = 0;
  entity.vel.y = 0;
  entity.vel.z = 0;

  broadcastCombatEvent(shard, {
    kind: "destroyed",
    target: entity.id,
    source: { kind: args.source.kind, id: args.source.id },
    tick: args.tick,
  });

  return {
    shieldHit: result.shieldHit,
    hullHit: result.hullHit,
    destroyed: true,
    newShields: result.newShields,
    newHull: result.newHull,
    hit: true,
    wreckSpawnedId: wreckId,
    destroyedTargetId: entity.id,
  };
}

/** Default empty result — used when the target isn't on the shard. */
const EMPTY_RESULT: ApplyCombatDamageResult = {
  shieldHit: 0,
  hullHit: 0,
  destroyed: false,
  newShields: 0,
  newHull: 0,
  hit: false,
  wreckSpawnedId: null,
  destroyedTargetId: null,
};

/** Result shape returned by `applyCombatDamage`. */
export interface ApplyCombatDamageResult {
  shieldHit: number;
  hullHit: number;
  destroyed: boolean;
  newShields: number;
  newHull: number;
  /** False when the target id wasn't on the shard. */
  hit: boolean;
  /** Set only when `destroyed === true` — the wreck entity id. */
  wreckSpawnedId: string | null;
  /** Set only when `destroyed === true` — the destroyed entity id. */
  destroyedTargetId: string | null;
}

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

/**
 * Convenience: a damage source tagged with a class id. Used by
 * tests + AI code (TASK-46) that wants to attribute damage to a
 * non-player attacker.
 */
export function aiSource(id: string): DamageSource {
  return { kind: "ai", id };
}

/**
 * Convenience: a damage source tagged with a player callsign.
 */
export function playerSource(id: string): DamageSource {
  return { kind: "player", id };
}
