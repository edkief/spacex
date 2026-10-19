/**
 * Hit resolver — TASK-42 combat core.
 *
 * This module houses `resolveHit`, the single entry point weapon
 * handlers (TASK-43) and hazards (TASK-48) call when a hit lands.
 * The function validates the hit on the authoritative server
 * (target alive, range, line-of-sight for surface combat, no
 * self-target, no destroyed-target), emits the protocol-level
 * `combat_event { kind: 'hit' }`, and delegates to
 * `applyCombatDamage` (TASK-23) for the shielded HP math +
 * `damaged` / `destroyed` / `kill` broadcast chain.
 *
 * Split out of `combat.ts` in TASK-42 so the original module
 * (which is dominated by `applyCombatDamage`'s several
 * discriminated branches) could stay under the AGENTS.md
 * 200-300 LOC cap.
 *
 * ## Line-of-sight math
 *
 * The spec calls for a 5-point subsampled raycast against the
 * terrain heightfield. The shader-accurate version would be a
 * proper DDA on the chunk's voxel grid; the v1 approximation is
 * 5 evenly-spaced `t` values from `source.pos` to
 * `damagePoint`. For each sample we compute the planet's surface
 * altitude at the sample's `(x, z)` (using the shard's
 * `heightAtFor` callback, identical to the regime manager) and
 * reject the ray when the sample's `y` is below that surface by
 * more than `LOS_TERRAIN_SLACK_M` (0.5 m).
 *
 * Space regime skips the check entirely — the source's
 * `originPlanetId` is `null` for a ship in pure space, so we
 * short-circuit before the sample loop.
 *
 * @see ./combat.ts for the damage pipeline.
 * @see ./combat-events.ts for the broadcast + cleanup helpers.
 * @see ../../shared/protocol/schemas.ts for the `combat_event`
 *      wire shape.
 */
import type { ProtocolCombatEvent } from "@shared/protocol/index.js";
import type { DamageSource } from "@shared/physics/damage.js";

import { applyCombatDamage, broadcastCombatEvent, type ApplyCombatDamageResult } from "./combat.js";
import type { Shard, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of line-of-sight subsamples (spec calls for "5 points"). */
export const LOS_SAMPLES = 5;

/**
 * Number of metres of vertical "slack" the LOS check tolerates
 * when comparing a sample's `world y` against the terrain altitude
 * at the sample's `(x, z)`. The 0.5 m buffer matches the
 * regime manager's `SURFACE_PROXIMITY_M` rounding so the
 * resolver and the regime manager agree on "what counts as
 * touching the ground". Without slack a sample exactly at
 * terrain altitude would count as "below" and the ray would be
 * falsely occluded.
 */
export const LOS_TERRAIN_SLACK_M = 0.5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The discriminant of the `WeaponId` shape consumed by
 * `resolveHit` and (later) the wire `fire` message (TASK-43).
 * The string tags match the wire protocol's
 * `combat_event.kind: 'hit' | 'destroyed' | 'kill'` weapon union
 * — `laser | missile`. New weapons require a protocol bump; the
 * resolver accepts the union as a plain string parameter so a
 * future `torpedo` entry flows through without changing the
 * function signature.
 */
export type WeaponId = "laser" | "missile";

/**
 * Discriminated reason a `resolveHit` call declined to apply
 * damage. The wire layer maps each code onto the protocol's
 * `ErrorCodeSchema` values (`self-target`, `out-of-range`, etc.)
 * so the client gets a structured rejection frame instead of a
 * silent drop.
 *
 *   - `'unknown-source'` — sourceId not on the shard.
 *   - `'unknown-target'` — targetId not on the shard.
 *   - `'self-target'`    — source and target are the same entity.
 *                          Always rejected per acceptance criterion.
 *   - `'dead-target'`    — target is destroyed (hull <= 0). Maps
 *                          to `not-found` on the wire (the
 *                          protocol has no `dead-target` code;
 *                          reusing the generic "not targetable"
 *                          code).
 *   - `'out-of-range'`   — source → damagePoint distance > max
 *                          range for the weapon.
 *   - `'line-of-sight'`  — terrain occluded the ray. Space regime
 *                          skips LOS entirely (the spec calls out
 *                          that "space has no LOS").
 *   - `'not-attackable'` — the source or the target is a kind
 *                          that the resolver refuses to dispatch
 *                          against (e.g. characters can't shoot
 *                          in v1).
 */
export type ResolveHitRejection =
  | "unknown-source"
  | "unknown-target"
  | "self-target"
  | "dead-target"
  | "out-of-range"
  | "line-of-sight"
  | "not-attackable";

/**
 * The result of `resolveHit`. On success, the same shape as the
 * bare `applyCombatDamage` result plus the broadcasted `hit`
 * event payload (the protocol sends
 * `{kind:'hit', attacker, target, weapon, damage, tick}` — see
 * `schemas.ts`).
 *
 * On rejection, `rejection` carries the rejection reason +
 * `apply` is `null` + `hitEvent` is `null`. Rejections don't
 * reach `applyCombatDamage`; the resolver short-circuits so a
 * friendly-fire attempt against a friendly ship never mutates HP.
 */
export type ResolveHitResult =
  | {
      ok: true;
      apply: ApplyCombatDamageResult;
      hitEvent: Extract<ProtocolCombatEvent, { kind: "hit" }>;
    }
  | {
      ok: false;
      rejection: ResolveHitRejection;
      apply: null;
      hitEvent: null;
    };

// ---------------------------------------------------------------------------
// resolveHit
// ---------------------------------------------------------------------------

/**
 * The combat core — TASK-42 keystone.
 *
 * Resolve a weapon hit on the authoritative server. Validates:
 *
 *   1. Source exists in the registry (rejection: `unknown-source`).
 *   2. Target exists in the registry (rejection: `unknown-target`).
 *   3. Source is not the same entity as target (rejection: `self-target`).
 *   4. Target is alive (`hull > 0`; rejection: `dead-target`).
 *   5. The hit is within the weapon's `range` (rejection: `out-of-range`).
 *   6. The source → damagePoint ray is not occluded by terrain
 *      when the source is on/near a planet's surface (rejection:
 *      `line-of-sight`). Space regime skips the LOS check
 *      entirely per the spec — there is no terrain to occlude
 *      against.
 *
 * On success:
 *   - Broadcasts `combat_event { kind: 'hit', attacker, target,
 *     weapon, damage, tick }` to every connection.
 *   - Delegates to `applyCombatDamage` for the shielded HP math
 *     + (`damaged`, `destroyed`, optional `kill`) broadcast +
 *     wreck spawn.
 *
 * Friendly fire is **ON** in v1 (TASK-47 PvP parity). The
 * resolver never rejects on source-kind == target-kind; a PvP
 * duel is a legal scenario. Future tasks that add team flags
 * should consult this contract before relaxing the friendly-fire
 * case.
 *
 * The resolver is intended for THE TICK THREAD and weapon
 * message handlers — both are sequential so the
 * registry-mutation race is bounded. Calling it from arbitrary
 * async paths is unsupported.
 *
 * @param args.shard            The shard the entities live on.
 * @param args.weapon           Weapon that landed the hit.
 *                              Forwarded onto the `hit` event
 *                              payload + the wreck (TASK-49
 *                              reads the wreck's `killerWeapon`
 *                              for the tooltip).
 * @param args.sourceId         Entity id of the attacker.
 * @param args.targetId         Entity id of the victim.
 * @param args.damage           Damage amount (positive finite).
 * @param args.damagePoint      World position of the impact.
 *                              Used only for LOS sampling; the
 *                              sim ignores it for damage math.
 * @param args.range            Maximum weapon range in metres.
 *                              Caller-supplied because each
 *                              weapon has its own range (TASK-43
 *                              supplies the catalog).
 * @param args.tick             Tick number for the wire frame.
 * @param args.nowMs            Wall-clock ms (defaults to
 *                              `Date.now()`).
 */
export function resolveHit(args: {
  shard: Shard;
  weapon: WeaponId;
  sourceId: string;
  targetId: string;
  damage: number;
  damagePoint: { x: number; y: number; z: number };
  range: number;
  tick: number;
  nowMs?: number;
}): ResolveHitResult {
  const shard = args.shard;

  // 1. Source exists. Skip self-target pre-check via the sourceId
  //    equality we test next (so a missing source fails with
  //    `unknown-source` rather than `self-target`).
  const source = shard.entities.get(args.sourceId);
  if (source === undefined) {
    return { ok: false, rejection: "unknown-source", apply: null, hitEvent: null };
  }

  // 2. Target exists. Same order as `source` — we never
  //    self-check a missing target.
  const target = shard.entities.get(args.targetId);
  if (target === undefined) {
    return { ok: false, rejection: "unknown-target", apply: null, hitEvent: null };
  }

  // 3. Self-target rejection. Explicit per the acceptance
  //    criteria — a ship can't fire at itself. Even non-attackable
  //    sources (e.g. a `kind: 'character'`) get refused here
  //    because the spec is "a ship cannot fire at itself" (and
  //    the same id is always a same-id rejection regardless of
  //    kind).
  if (args.sourceId === args.targetId) {
    return { ok: false, rejection: "self-target", apply: null, hitEvent: null };
  }

  // 4. Target alive (TASK-23 acceptance: destroyed entities are
  //    not targetable). We test BEFORE the source kind gates
  //    below so a destroyed-target rejection always wins over a
  //    not-attackable one.
  if (target.hull <= 0) {
    return { ok: false, rejection: "dead-target", apply: null, hitEvent: null };
  }

  // 5. Source kind gate. The combat core is "ship vs ship" in v1
  //    — characters carry no weapon (TASK-31), AI ships + player
  //    ships are the two legitimate attackers. We accept
  //    `kind: 'player' | 'ai'` only (AI ships are integrated by
  //    the future TASK-46 state machine; for v1 tests the
  //    fixture can spawn an ai entity and have it "fire" via
  //    the resolver directly).
  if (source.kind !== "player" && source.kind !== "ai") {
    return { ok: false, rejection: "not-attackable", apply: null, hitEvent: null };
  }
  // 6. Target kind gate. Characters + deposits + terminals +
  //    ground items + wrecks can't be hit by weapons in v1.
  if (
    target.kind === "character" ||
    target.kind === "deposit" ||
    target.kind === "terminal" ||
    target.kind === "groundItem" ||
    target.kind === "wreck"
  ) {
    return { ok: false, rejection: "not-attackable", apply: null, hitEvent: null };
  }

  // 7. Range check. `damagePoint` is the impact location (where
  //    the weapon visually landed). A hit at the weapon's max
  //    range passes; everything beyond is rejected. The check is
  //    conservative — we also let future TASK-50 HUD show the
  //    "out of range" toast when the player aimed at a target
  //    further than the weapon's reach.
  const distSqToHit =
    (args.damagePoint.x - source.pos.x) ** 2 +
    (args.damagePoint.y - source.pos.y) ** 2 +
    (args.damagePoint.z - source.pos.z) ** 2;
  if (distSqToHit > args.range * args.range) {
    return { ok: false, rejection: "out-of-range", apply: null, hitEvent: null };
  }

  // 8. LOS check. Spec: "raycast source → damagePoint against
  //    the terrain heightfield (subsampled 5 points; any point
  //    below terrain = occluded) — space regime skips LOS
  //    entirely". Implementation: 5 evenly-spaced samples on
  //    the ray (source and damagePoint inclusive), each compared
  //    against the terrain altitude at that sample's
  //    planet-local (x, z).
  //
  //    The planet we sample against is the source's
  //    `originPlanetId` (i.e. the planet the source is currently
  //    orbiting / over). A source in pure space (no atmosphere
  //    planet) skips the LOS check entirely; a source whose
  //    planet doesn't resolve also skips.
  const losRejection = checkLineOfSight({
    shard,
    source,
    target,
    damagePoint: args.damagePoint,
  });
  if (losRejection !== null) {
    return { ok: false, rejection: losRejection, apply: null, hitEvent: null };
  }

  // 9. Build the damage source attribution. For player attackers
  //    the source `id` is the callsign; for AI attackers it's the
  //    AI roster id. The `entityId` is the *separate* technical
  //    handle the resolver forwards to `applyCombatDamage` for
  //    the kill attribution / wreck-killer record.
  const sourceAttribution: DamageSource =
    source.kind === "player"
      ? { kind: "player", id: source.callsign ?? source.id }
      : { kind: "ai", id: source.callsign ?? source.id };

  // 10. Emit the `hit` event BEFORE applying damage so the wire
  //     frame order matches the spec ("hit, destroyed, kill").
  //     The HUD uses this to render the muzzle flash + the
  //     "X hit your shields for N" toast.
  const hitEvent: Extract<ProtocolCombatEvent, { kind: "hit" }> = {
    kind: "hit",
    attacker: sourceAttribution.kind === "player" ? (source.callsign ?? source.id) : source.id,
    target: target.id,
    weapon: args.weapon,
    damage: args.damage,
    tick: args.tick,
  };
  broadcastCombatEvent(shard, hitEvent);

  // 11. Apply damage. This call emits `damaged` and (if it
  //     kills) `destroyed` + the optional `kill` broadcast —
  //     see `applyCombatDamage` for the sequence.
  const apply = applyCombatDamage({
    shard,
    targetId: target.id,
    amount: args.damage,
    source: sourceAttribution,
    tick: args.tick,
    nowMs: args.nowMs,
    sourceEntityId: source.id,
    weapon: args.weapon,
  });
  return { ok: true, apply, hitEvent };
}

// ---------------------------------------------------------------------------
// Internal — line-of-sight check
// ---------------------------------------------------------------------------

/**
 * The 5-point subsampled LOS check that backs `resolveHit`.
 *
 * The spec mandates that this check (a) be cheap — 5 samples is
 * comfortably under a microsecond and (b) only fire when terrain
 * could plausibly block the ray — pure space has no terrain, so
 * we skip the check entirely.
 *
 * The function is intentionally narrow + pure (no registry
 * mutations, no broadcast) so it can be unit-tested in isolation
 * against an analytic terrain function.
 *
 * Returns `null` when the ray is clear (hit is valid); returns
 * `'line-of-sight'` when any sample is occluded (hit is rejected).
 *
 * @param args.shard        Live shard. Used only for the
 *                          `heightAtFor` lookup — no mutations.
 * @param args.source       Source entity (already validated to
 *                          be a player / ai ship).
 * @param args.target       Target entity (already validated to
 *                          be a player / ai ship with hull > 0).
 * @param args.damagePoint  World-space impact point (end of the
 *                          ray).
 */
export function checkLineOfSight(args: {
  shard: Shard;
  source: SimEntity;
  target: SimEntity;
  damagePoint: { x: number; y: number; z: number };
}): "line-of-sight" | null {
  // Space regime → no terrain, no LOS test. Spec calls this
  // out explicitly: "space has no LOS". We use the *source's*
  // `originPlanetId` because a target on a planet doesn't make
  // the source in space — if the firer is in space the ray is
  // always clear.
  const planetId = args.source.originPlanetId;
  if (planetId === null || planetId === undefined) {
    return null;
  }
  const heightAt = args.shard.context.heightAtFor(planetId);
  if (heightAt === undefined) {
    // No terrain function registered → conservative "no LOS
    // test possible, fire". A flat world should never block a
    // ray.
    return null;
  }
  const planet = args.shard.context.planetById(planetId);
  if (planet === undefined) {
    return null;
  }
  // The surface altitude the shot grazes past is
  // `planet.radius + heightAt(localX, localZ)`. We don't add
  // `planet.center.y` here because v1 places planets at the
  // world origin and the `heightAt(localX, localZ)` callback
  // doesn't shift based on planet position (matches the
  // regime manager's `distanceToSurface` math).
  const surfaceY = planet.radiusKm * 1000;

  // Subsample the ray in even steps. Using `i / (LOS_SAMPLES - 1)`
  // includes BOTH endpoints — the spec calls out that the
  // impact point is part of the test, so a shot that lands
  // *below* the terrain at the impact point counts as
  // occluded.
  const n = LOS_SAMPLES;
  const sx = args.source.pos.x;
  const sy = args.source.pos.y;
  const sz = args.source.pos.z;
  const dx = args.damagePoint.x - sx;
  const dy = args.damagePoint.y - sy;
  const dz = args.damagePoint.z - sz;

  for (let i = 0; i < n; i++) {
    // `n` is a literal `5` at compile-time so the comparison is
    // a no-op. The runtime guard is in case a future task
    // parameterises the sample count.
    const t = (i as number) / ((n - 1) as number);
    const sxT = sx + dx * t;
    const syT = sy + dy * t;
    const szT = sz + dz * t;
    // Terrain altitude at the sample's planet-local (x, z).
    // Local frame = world frame (v1 places planets at the
    // world origin so the translation is identity).
    const terrainAlt = heightAt(sxT, szT);
    const sampleSurfaceY = surfaceY + terrainAlt;
    if (syT < sampleSurfaceY - LOS_TERRAIN_SLACK_M) {
      return "line-of-sight";
    }
  }
  return null;
}
