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

import { makeWreckEntity, makeWreckId } from "./entity.js";
import { broadcastCombatEvent } from "./combat-events.js";
import { RESPAWN_DELAY_MS, scheduleAiRespawn } from "./ai-respawn.js";
import { noteAiDamagedBy } from "./ai.js";
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
 *   - TASK-42: when `sourceEntityId` is supplied AND `source.kind
 *     === 'player'`, the destroying call also broadcasts a
 *     `combat_event` with `kind: 'kill'`. The `kill` event carries
 *     the attacker's callsign so the killer can show up in
 *     post-combat recaps without a server-side lookup.
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
  /**
   * TASK-42: entity id of the source. Required for `kill` event
   * attribution — the `damage.source.id` is the callsign/roster
   * id (a *human-readable* handle), while this is the entity id
   * (the *technical* handle the HUD uses to dedupe and the
   * renderer uses to find the killer's impostor). When the
   * weapon handler can resolve it, supply it here. The wreck
   * spawn also stores it on the wreck entity (TASK-49).
   */
  sourceEntityId?: string;
  /**
   * TASK-42: weapon that landed the hit. Forwarded onto the
   * wreck so the skull tooltip can mention it. Required for
   * `kill` events (the protocol's `kill` schema currently carries
   * `attacker / target / tick`; the weapon-specific tooltip lives
   * on the wreck).
   */
  weapon?: "laser" | "missile";
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

  // TASK-46: note the player source in the AI's recentlyDamagedBy
  // map so the AGGRO check (`pickAggroTarget`) sees a fresh hit
  // inside the AGGRO_RECENT_FIRE_MS window. We do this BEFORE the
  // destroy short-circuit so a killing blow still triggers AGGRO
  // (the player is clearly hostile). Note: this is also the
  // contract that the ACQUIRING toast piggy-backs on — when an AI
  // is being fired on by a player, AGGRO engages and the toast
  // fires on transition.
  if (entity.kind === "ai" && args.source.kind === "player") {
    noteAiDamagedBy(shard, {
      aiId: entity.id,
      playerId: args.source.id,
      nowMs: args.nowMs ?? Date.now(),
    });
  }

  // Apply the damage to the live entity in place.
  entity.hull = result.newHull;
  entity.shields = result.newShields;

  // TASK-42: build the kill attribution once so both the wreck
  // entity and the optional `kill` event can reuse it. Only
  // builds when the caller supplied a source entity id AND a
  // weapon — the wreck needs both to render the skull tooltip
  // (TASK-49). Missing attribution is a non-fatal no-op for the
  // kill event (the `destroyed` event still fires either way).
  const killer:
    | { entityId: string; kind: "player" | "ai" | "drone"; weapon: "laser" | "missile" }
    | undefined =
    args.sourceEntityId !== undefined && args.weapon !== undefined
      ? {
          entityId: args.sourceEntityId,
          // Drones can't carry a `weapon` (the damage pipeline
          // signature narrows the union). Default to `laser` so
          // the wreck still records an attribution; drone kills
          // never reach this code path in practice (drones die
          // via the hazard pipeline, not through
          // `applyCombatDamage`).
          kind: args.source.kind,
          weapon: args.weapon,
        }
      : undefined;

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

  // TASK-45: rogue-AI ships don't leave a wreck — when one is
  // destroyed we drop the entity, broadcast the canonical
  // `combat_event { destroyed }` so the HUD can render the
  // kill, and schedule a 120 s respawn at `aiSpawnPos`. The
  // same `kind: 'kill'` event still fires for player kills
  // (the rogue's callsign becomes the `target.callsign` for the
  // toast log). A future TASK-46 + TASK-48 may extend this to
  // surface environmental deaths too.
  if (entity.kind === "ai") {
    const now = args.nowMs ?? Date.now();
    scheduleAiRespawn(shard, {
      aiId: entity.id,
      spawnPos: entity.aiSpawnPos ?? { x: entity.pos.x, y: entity.pos.y, z: entity.pos.z },
      classId: entity.classId as NonNullable<SimEntity["classId"]>,
      callsign: entity.callsign ?? entity.id,
      respawnAtMs: now + RESPAWN_DELAY_MS,
    });
    // Kill attribution: player kills on rogues emit `kind: 'kill'`
    // so the player kill-log surfaces "you destroyed
    // <callsign>". AI sources don't (the kill log is for the
    // player recap, not generic AI combat telemetry).
    if (killer?.kind === "player") {
      broadcastCombatEvent(shard, {
        kind: "kill",
        attacker: args.source.id,
        target: entity.id,
        tick: args.tick,
      });
    }
    return {
      shieldHit: result.shieldHit,
      hullHit: result.hullHit,
      destroyed: true,
      newShields: result.newShields,
      newHull: result.newHull,
      hit: true,
      wreckSpawnedId: null,
      destroyedTargetId: entity.id,
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
    // TASK-42: propagate kill attribution onto the wreck so
    // TASK-49 can render the skull marker with the right
    // tooltip. `killer` is `undefined` when the caller didn't
    // supply a sourceEntityId — those wrecks render without an
    // attribution flag (rare — typically a future TASK-48
    // environmental hazard).
    killer,
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

  // TASK-42: fire a `kill` event whenever the source is a player
  // AND the wreck has a killer record. AI-on-AI kills don't emit
  // (the post-combat recap is the *player* kill log, not a
  // generic kill log). The `attacker` is the callsign so the
  // HUD can show "Killer: <callsign>" without a second lookup;
  // when the weapon handler doesn't supply a source, this
  // branch is skipped and only `destroyed` fires.
  if (killer?.kind === "player") {
    broadcastCombatEvent(shard, {
      kind: "kill",
      attacker: args.source.id,
      target: entity.id,
      tick: args.tick,
    });
  }

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
// Source factories — used by tests + future AI code (TASK-46).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Re-exports — companion module hosts the broadcast + cleanup helpers
// that were extracted in TASK-42 so this file could absorb the
// resolveHit LOS logic without exceeding the AGENTS.md 200-300 LOC
// cap. The barrel re-export keeps existing imports stable.
// ---------------------------------------------------------------------------

export { broadcastCombatEvent, cleanupExpiredWrecks } from "./combat-events.js";
