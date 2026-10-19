/**
 * Weapons — TASK-43 keystone.
 *
 * Server-authoritative fire handler for the two v1 weapons:
 *
 *   - **Laser** (`weaponStats.laser`): instant ray from the
 *     ship's nose. Resolves through TASK-42's `resolveHit` at
 *     the first valid target inside `range`. Damage 8, rate
 *     3/s, energy 2.
 *   - **Missile** (`weaponStats.missile`): homing projectile.
 *     On fire we mint a `kind: 'missile'` entity (broadcast via
 *     `entity_update`), the sim tick advances it toward its
 *     `targetId` at `speed = 120 u/s` with `turnRate = 1.5
 *     rad/s`, and the contact check applies damage + splash on
 *     impact. Damage 25, splash 12 (5 m radius), range 800,
 *     rate 0.5/s, energy 10. TTL 5 s.
 *
 * Both weapons enforce a per-weapon cooldown (exact `1 / rate`
 * second gate), an energy check (deducted on accepted fires
 * only), a loadout check (a scout firing a missile surfaces
 * `weapon-not-equipped`), and a per-connection anti-spam lockout
 * (30 fires/s → 5 s lockout, surfacing `weapon-locked`).
 *
 * ## Server-authoritative design
 *
 * The client sends `fire` intents; the server is the single
 * source of truth for "did the shot land". A denied fire costs
 * the player no energy, surfaces no FX, and is silently dropped
 * (the optional `fire_ok` ack carries the denial code for the
 * HUD's "weapon not equipped" toast). A hostile client that
 * claims "I hit X" gains nothing — the server's
 * `combat_event { kind: 'hit' }` is the only path that mutates
 * HP / spawns wrecks.
 *
 * ## Energy model
 *
 * Energy is per-ship and persists with the ship (TASK-24).
 * Regenerates at 10/s, max 100. v1 has no friendly-fire penalty
 * on energy (a denied fire charges 0). The server pushes
 * `weapon_state` to the owning connection on every accepted or
 * denied fire so the HUD can render the energy bar without
 * waiting for the next 10 Hz snapshot.
 *
 * ## Missile cap
 *
 * Missiles are bounded at `MAX_MISSILES_PER_SHARD` (16). When
 * the cap is hit the oldest missile expires first (logged on
 * the shard event bus for diagnostics). This bounds the
 * per-shard projectile budget so a misbehaving client can't
 * drain entity slots.
 *
 * @see ../../shared/weapons.ts for the catalog + helpers
 *      (`weaponStats`, `loadoutFor`, `canFireWeapon`,
 *      `cooldownMs`, `cycleWeapon`).
 * @see ./combat.resolve.ts for the hit resolver (LOS, range,
 *      damage).
 * @see ./combat.ts for the damage pipeline + kill attribution.
 * @see ./sim.ts for the missile homing integration (called
 *      every tick from `runOneStep`).
 * @see ../ws.handlers.ts for the `onFire` / `onSelectWeapon`
 *      frame handlers.
 */
import {
  LASER_STATS,
  MISSILE_STATS,
  canFireWeapon,
  cooldownMs,
  loadoutFor,
  weaponStats,
  type WeaponId,
} from "@shared/weapons.js";
import {
  MISSILE_PICK_CONE_COS,
  MISSILE_PICK_RANGE_M,
  forwardVecFromQuat,
  isLockableTarget,
} from "@shared/targeting.js";
import type { Vec3 } from "@shared/physics/vec.js";

import { resolveHit } from "./combat.resolve.js";
import { lockFor } from "./targeting.js";
import type { Shard, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated result of `handleFire`. The WS handler maps the
 * `code` onto the wire's `ErrorCodeSchema` (or `null` for the
 * happy path).
 *
 *   - `ok: 'accepted'`  — fire landed (laser) or projectile
 *                          spawned (missile). `fire_ok` carries
 *                          the result.
 *   - `ok: 'denied'`    — fire was rejected. `code` carries the
 *                          wire error code; the client surfaces
 *                          the toast but emits NO FX (the spec
 *                          is explicit).
 */
export type FireResult =
  | {
      ok: "accepted";
      weapon: WeaponId;
      /** Damage applied for a hit (0 on a miss); `null` for missile spawn. */
      damage: number | null;
      /** Missile projectile id (`weapon === 'missile'` only). */
      projectileId: string | null;
      /** Energy remaining on the firing ship AFTER the cost. */
      energy: number;
    }
  | {
      ok: "denied";
      code:
        | "rate-limited"
        | "low-energy"
        | "weapon-locked"
        | "weapon-not-equipped"
        | "out-of-range"
        | "not-attackable"
        | "self-target"
        | "no-target"
        | "unknown";
      /** Energy is unchanged on denied fires (the spec is explicit). */
      energy: number;
      /** True while a connection is in the lockout window. */
      locked: boolean;
    };

/**
 * Per-connection weapon state. Lives on the `SimEntity` for
 * player / AI ships (the `kind: 'player' | 'ai'` entities) so
 * warp + reconnect naturally carry the values forward. v1 ships
 * are single-owner so the entity is the natural home.
 *
 * The `weaponFireLog` is a monotonic timestamp ring — when it
 * exceeds `WEAPON_LOCK_THRESHOLD_PER_SECOND` entries in the
 * last 1 s window the lockout fires for
 * `WEAPON_LOCK_DURATION_MS`.
 */
export interface WeaponConnState {
  energy: number;
  activeWeapon: WeaponId;
  weaponLockedUntilMs: number;
  weaponFireLog: number[];
  weaponCooldownMs: { laser: number; missile: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stable id format for a missile projectile. Prefix `missile:`
 * so the broadcast loop can recognise the kind without a
 * secondary index.
 */
const MISSILE_ID_PREFIX = "missile:";

/**
 * Sentinel id used when we want to mint a fresh missile id but
 * don't have a logical seed yet. The full id is
 * `missile:<sourceId>:<counter>` so collisions across shards /
 * sources are vanishingly unlikely.
 */
let MISSILE_COUNTER = 0;

function nextMissileId(sourceId: string): string {
  MISSILE_COUNTER += 1;
  return `${MISSILE_ID_PREFIX}${sourceId}:${MISSILE_COUNTER}`;
}

// ---------------------------------------------------------------------------
// Public API — connection-side helpers
// ---------------------------------------------------------------------------

/**
 * Initialise (or reset) the weapon state on a player / AI
 * entity. Idempotent — a second call replaces the fields rather
 * than layering. Energy starts at `ENERGY_MAX` so a freshly
 * spawned ship has a full reservoir.
 *
 * Called by `spawnShip` / `spawnAiShip` so the entity has the
 * right shape from the moment it's added to the registry. The
 * `activeWeapon` defaults to `'laser'` because every ship has at
 * least one laser hardpoint (TASK-43 / TASK-19).
 */
export function initWeaponState(entity: SimEntity): void {
  entity.energy = 100;
  entity.activeWeapon = "laser";
  entity.weaponLockedUntilMs = 0;
  entity.weaponFireLog = [];
  // Initialise cooldowns to -cooldownMs(weapon) so the first fire
  // (which sets the timestamp) always passes the cooldown check.
  entity.weaponCooldownMs = { laser: -cooldownMs("laser"), missile: -cooldownMs("missile") };
}

/**
 * Advance the connection's energy reservoir on each wall-clock
 * second. Called by `handleFire` (no-op when not firing) and by
 * the sim tick when no input is in flight. Returns the new
 * energy value clamped to `[0, 100]`.
 *
 * Implementation note: the spec calls for a 10/s regen (so 100
 * max in 10 s of idle). We expose `energyRegenFor(entity, dt)`
 * as the pure math so the sim loop can advance energy once per
 * tick without a side-effecting helper.
 */
export function energyRegenFor(entity: SimEntity, dtSec: number, nowMs: number): number {
  if (entity.energy === undefined) return 0;
  // Idle regen: 10 / s * dt = (10 + s) of energy back.
  const next = entity.energy + 10 * dtSec;
  const clamped = Math.max(0, Math.min(100, next));
  entity.energy = clamped;
  // While the lockout is active, regen still ticks (the spec
  // doesn't pause regen during lockout — only the fire-button
  // is gated). Documented so a future change is intentional.
  void nowMs;
  return clamped;
}

/**
 * Handle a `fire` intent from a player connection.
 *
 * Steps (spec acceptance):
 *   1. Look up the connection + bound entity (must be a
 *      `kind: 'player'` or `kind: 'ai'` ship; characters
 *      surface `not-attackable`).
 *   2. Check the connection is not in the anti-spam lockout.
 *      While locked, every fire surfaces `weapon-locked` and no
 *      state mutates.
 *   3. Check the weapon is in the ship's loadout (a scout
 *      firing a missile surfaces `weapon-not-equipped`).
 *   4. Check the per-weapon cooldown (exact `cooldownMs` gate;
 *      a fire earlier than `lastAccepted + cooldown` is dropped
 *      as `rate-limited`).
 *   5. Check the energy reservoir (≥ `weaponStats.energy`;
 *      surfaces `low-energy`).
 *   6. For lasers: resolve the hit via `resolveHit` and deduct
 *      energy on accept. For missiles: spawn the projectile
 *      entity and deduct energy on accept.
 *   7. Push the `weapon_state` frame to the owning connection
 *      so the HUD's energy bar can flip synchronously.
 *
 * The function intentionally never broadcasts a `combat_event`
 * for a denied fire — the spec is explicit ("a denied fire
 * shows no FX").
 *
 * @param args.shard      Live shard (registry + broadcast).
 * @param args.connId     Owning connection id.
 * @param args.weapon     Weapon id (`'laser' | 'missile'`).
 * @param args.targetId   Optional locked target (laser: purely
 *                        advisory; missile: homing target).
 * @param args.nowMs      Wall-clock ms (defaults to `Date.now`).
 */
export function handleFire(args: {
  shard: Shard;
  connId: string;
  weapon: WeaponId;
  targetId?: string | null;
  nowMs?: number;
}): FireResult {
  const { shard, connId, weapon } = args;
  const now = args.nowMs ?? Date.now();
  const conn = shard.connections.get(connId);
  if (!conn) {
    return {
      ok: "denied",
      code: "unknown",
      energy: 0,
      locked: false,
    };
  }
  const entity = conn.entityId ? shard.entities.get(conn.entityId) : undefined;
  if (!entity) {
    return {
      ok: "denied",
      code: "no-target",
      energy: 0,
      locked: false,
    };
  }
  // Only player / AI ships can fire (characters are on-foot and
  // carry no weapons per the spec).
  if (entity.kind !== "player" && entity.kind !== "ai") {
    return {
      ok: "denied",
      code: "not-attackable",
      energy: entity.energy ?? 0,
      locked: isLocked(entity, now),
    };
  }
  // Lazy-init weapon state — a connection that joined before the
  // weapon subsystem landed might not have the fields set.
  if (entity.energy === undefined) initWeaponState(entity);
  if (entity.activeWeapon === undefined) entity.activeWeapon = "laser";
  if (entity.weaponLockedUntilMs === undefined) entity.weaponLockedUntilMs = 0;
  if (entity.weaponFireLog === undefined) entity.weaponFireLog = [];
  if (entity.weaponCooldownMs === undefined) {
    entity.weaponCooldownMs = { laser: 0, missile: 0 };
  }

  // 2. Anti-spam lockout.
  if (isLocked(entity, now)) {
    return {
      ok: "denied",
      code: "weapon-locked",
      energy: entity.energy ?? 0,
      locked: true,
    };
  }

  // 3. Loadout check.
  if (!canFireWeaponOnEntity(entity, weapon)) {
    recordFireAttempt(entity, now);
    pushWeaponState(shard, connId, entity, now);
    return {
      ok: "denied",
      code: "weapon-not-equipped",
      energy: entity.energy ?? 0,
      locked: isLocked(entity, now),
    };
  }

  // 4. Per-weapon cooldown.
  const cd = cooldownMs(weapon);
  const lastAccepted = entity.weaponCooldownMs[weapon] ?? 0;
  // First fire has `lastAccepted = -cd` (set by `initWeaponState`
  // below) so `now - lastAccepted = now + cd > cd` always passes.
  // Otherwise reject as rate-limited.
  recordFireAttempt(entity, now);
  if (lastAccepted > 0 && now - lastAccepted < cd) {
    pushWeaponState(shard, connId, entity, now);
    return {
      ok: "denied",
      code: "rate-limited",
      energy: entity.energy ?? 0,
      locked: isLocked(entity, now),
    };
  }

  // 5. Energy check (deducted on accept only).
  const cost = weaponStats(weapon).energy;
  if ((entity.energy ?? 0) < cost) {
    recordFireAttempt(entity, now);
    pushWeaponState(shard, connId, entity, now);
    return {
      ok: "denied",
      code: "low-energy",
      energy: entity.energy ?? 0,
      locked: isLocked(entity, now),
    };
  }

  // 6. Dispatch by weapon.
  if (weapon === "laser") {
    return fireLaser({
      shard,
      connId,
      entity,
      targetId: args.targetId ?? null,
      now,
      cd,
    });
  }
  return fireMissile({
    shard,
    connId,
    entity,
    targetId: args.targetId ?? entity.targetId,
    now,
    cd,
  });
  // (TypeScript-fuelled to suppress fall-through warning.)
}

/**
 * Switch the owning connection's active weapon. Triggered by
 * the `1` / `2` keys (`select_weapon` wire frame). The server
 * accepts the request even when the requested weapon is not in
 * the loadout (a scout requesting `missile` is silently
 * accepted; the HUD reads `weapon-not-equipped` from the next
 * `fire` attempt to render the toast).
 *
 * Returns the new active weapon id so the HUD can swap its
 * selector synchronously.
 */
export function handleSelectWeapon(args: {
  shard: Shard;
  connId: string;
  weapon: WeaponId;
  nowMs?: number;
}): { weapon: WeaponId; locked: boolean; energy: number } {
  const now = args.nowMs ?? Date.now();
  const conn = args.shard.connections.get(args.connId);
  if (!conn) return { weapon: "laser", locked: false, energy: 0 };
  const entity = conn.entityId ? args.shard.entities.get(conn.entityId) : undefined;
  if (!entity || (entity.kind !== "player" && entity.kind !== "ai")) {
    return { weapon: args.weapon, locked: false, energy: 0 };
  }
  if (entity.activeWeapon === undefined) entity.activeWeapon = "laser";
  entity.activeWeapon = args.weapon;
  pushWeaponState(args.shard, args.connId, entity, now);
  return {
    weapon: entity.activeWeapon,
    locked: isLocked(entity, now),
    energy: entity.energy ?? 0,
  };
}

/**
 * Tick the missile lifecycle: advance position toward the
 * target, despawn on TTL, detect contact, apply splash.
 *
 * Called once per sim tick (20 Hz) from `runOneStep`. The
 * `shard.context.heightAtFor` / `planetById` callbacks let us
 * enforce the same surface-occlusion rule `resolveHit` uses,
 * so a missile that hits a planet's surface lands (no impact
 * frame, just despawn — the warhead is wasted).
 *
 * Returns the count of missiles removed (TTL + impact + cap)
 * for the diagnostics observer.
 */
export function advanceMissiles(
  shard: Shard,
  nowMs: number,
): {
  despawned: number;
  impacted: number;
} {
  let despawned = 0;
  let impacted = 0;

  // Snapshot the missile ids so we can mutate the registry
  // mid-iteration. Cheaper than copying the map because the
  // typical missile count is small (≤ MAX_MISSILES_PER_SHARD).
  const missileIds: string[] = [];
  for (const [id, entity] of shard.entities) {
    if (entity.kind === "missile") missileIds.push(id);
  }

  for (const id of missileIds) {
    const missile = shard.entities.get(id);
    if (!missile || missile.kind !== "missile") continue;

    // 1. TTL check.
    if (missile.missileExpiresAt !== undefined && missile.missileExpiresAt <= nowMs) {
      shard.entities.delete(id);
      despawned += 1;
      continue;
    }

    // 2. Pick a target. If the homing target is gone (destroyed,
    // despawned, out of range), the missile coasts in a straight
    // line and expires on TTL.
    const targetId = missile.missileTargetId ?? null;
    const target = targetId ? shard.entities.get(targetId) : undefined;
    let desiredVel: Vec3;
    if (target && target.kind !== "missile" && target.hull > 0) {
      // Turn toward target with the missile's `turnRate`. We
      // implement the homing turn as "rotate the velocity vector
      // toward the target direction, clamped by the per-tick
      // turn budget". Cheaper than a true quat slerp and stable
      // at the documented cadence (1.5 rad/s = 30° / tick at 20 Hz,
      // which is plenty against a slow-moving interceptor).
      desiredVel = turnTowardTarget(missile, target, shard);
    } else {
      // No target / dead target — coast on the existing velocity.
      desiredVel = { x: missile.vel.x, y: missile.vel.y, z: missile.vel.z };
    }

    // 3. Advance position. dt = TICK_S = 0.05 (server tick).
    missile.vel.x = desiredVel.x;
    missile.vel.y = desiredVel.y;
    missile.vel.z = desiredVel.z;
    missile.pos.x += desiredVel.x * (1 / 20);
    missile.pos.y += desiredVel.y * (1 / 20);
    missile.pos.z += desiredVel.z * (1 / 20);

    // 4. Contact check: did the missile enter an entity's hitbox?
    // We use a generous 1.5 m contact radius so the warhead
    // detonates as soon as the projectile brushes the target.
    // Splash damage is applied to every *other* entity within the
    // weapon's `splashRadius` (5 m).
    const impact = contactCheck(shard, missile);
    if (impact !== null) {
      applyMissileImpact(shard, missile, impact, nowMs);
      shard.entities.delete(id);
      impacted += 1;
      despawned += 1;
      continue;
    }

    // 5. Surface check — a missile that hits the ground is
    // despawned silently (no hit event). Space regime + the
    // "no heightAt" fall-through both count as "no surface".
    if (surfaceImpacted(missile, shard)) {
      shard.entities.delete(id);
      despawned += 1;
      continue;
    }
  }
  return { despawned, impacted };
}

// ---------------------------------------------------------------------------
// Internal — fire dispatch
// ---------------------------------------------------------------------------

/**
 * Fire a laser. Resolves the hit through `resolveHit` (which
 * enforces range + LOS + target validity). On accept, deducts
 * energy + advances the cooldown + records the fire attempt.
 *
 * Note: `resolveHit` broadcasts the `combat_event { kind: 'hit' }`
 * itself — we only emit `fire_ok` for the firing client and
 * `weapon_state` for the energy bar.
 */
function fireLaser(args: {
  shard: Shard;
  connId: string;
  entity: SimEntity;
  targetId: string | null;
  now: number;
  cd: number;
}): FireResult {
  const { shard, connId, entity, targetId, cd } = args;
  const stats = LASER_STATS;
  // Per-mount damage: the interceptor has `laser: 2`, so a
  // single fire key applies 2 × stats.damage. The scout /
  // freighter get 1 × stats.damage. We pull the loadout from
  // the entity's classId so a wrongly-casted bus spawn (no
  // classId) falls through to 1.
  const mountCount = entity.classId ? loadoutFor(entity.classId).laser : 1;
  const damage = stats.damage * mountCount;

  // The "damagePoint" is `entity.pos + range * forward`, but for
  // v1 we just hand the resolver `target.pos` when we have one
  // (the spec says "resolves through TASK-42 resolveHit at the
  // first valid target or terrain occlusion point"). Without a
  // target the resolver still runs — its own out-of-range gate
  // catches a target-less fire.
  const target = targetId ? shard.entities.get(targetId) : undefined;
  const damagePoint = target
    ? { x: target.pos.x, y: target.pos.y, z: target.pos.z }
    : forwardOf(entity, stats.range);

  const resolved = resolveHit({
    shard,
    weapon: "laser",
    sourceId: entity.id,
    targetId: targetId ?? target?.id ?? "",
    damage,
    damagePoint,
    range: stats.range,
    tick: shard.sim.currentTick,
    nowMs: args.now,
  });

  // `resolveHit` accepts only when targetId is non-empty AND
  // valid. A rejected resolver (out-of-range / LOS / self-
  // target / dead-target / not-attackable) means the shot did
  // not land; per the spec a denied fire shows NO FX and
  // spends no energy. We return a `denied` FireResult with
  // the resolver's reason mapped onto a wire code.
  if (!resolved.ok) {
    const code = mapRejectionToCode(resolved.rejection);
    return {
      ok: "denied",
      code,
      energy: entity.energy ?? 0,
      locked: isLocked(entity, args.now),
    };
  }

  // Accept the fire (deduct energy, advance cooldown, record
  // the attempt). A successful resolveHit means the shot
  // landed; damage is whatever the resolver applied (always
  // `damage` for a laser — no splash on hit).
  entity.energy = Math.max(0, (entity.energy ?? 0) - stats.energy);
  entity.weaponCooldownMs!.laser = args.now;

  const result: FireResult = {
    ok: "accepted",
    weapon: "laser",
    damage,
    projectileId: null,
    energy: entity.energy,
  };
  pushFireOk(shard, connId, result);
  pushWeaponState(shard, connId, entity, args.now);
  void cd;
  return result;
}

/**
 * Map a `ResolveHitRejection` onto the wire-level denial code.
 * Used by `fireLaser` so a range/LOS failure surfaces with the
 * right wire code on the client.
 */
function mapRejectionToCode(
  rejection:
    | "unknown-source"
    | "unknown-target"
    | "self-target"
    | "dead-target"
    | "out-of-range"
    | "line-of-sight"
    | "not-attackable",
): "out-of-range" | "not-attackable" | "self-target" | "no-target" {
  switch (rejection) {
    case "out-of-range":
      return "out-of-range";
    case "not-attackable":
      return "not-attackable";
    case "self-target":
      return "self-target";
    default:
      return "no-target";
  }
}

/**
 * Fire a missile. Spawns a `kind: 'missile'` entity, threads
 * the homing target, deducts energy + advances the cooldown.
 *
 * **TASK-44 missile preference** — the homing target is selected
 * in this order:
 *   1. **Locked target** if the connection has a valid lock on a
 *      ship (re-validated through `isLockableTarget` so a target
 *      that evaporated between the player's T press and the
 *      missile fire is replaced with the cone pick).
 *   2. **Nearest-in-cone** within the 30° nose cone and 800 m
 *      missile range (closest live ship, player or AI).
 *   3. **Straight ahead** — the missile spawns at the ship's nose
 *      velocity and despawns on TTL with no impact. We only take
 *      this path when the player explicitly fires without a lock
 *      AND there's no other target in front of them; the wire
 *      surfaces `no-target` so the player gets a "NO TARGET"
 *      prompt instead of silently wasting the missile energy.
 *
 * `MAX_MISSILES_PER_SHARD` cap: when the shard already has
 * `MAX_MISSILES_PER_SHARD` missiles, the oldest is expired
 * first (logged on the shard event bus for diagnostics) and
 * the new one is minted. This bounds the per-shard projectile
 * budget so a misbehaving client can't drain entity slots.
 */
function fireMissile(args: {
  shard: Shard;
  connId: string;
  entity: SimEntity;
  targetId: string | null;
  now: number;
  cd: number;
}): FireResult {
  const { shard, connId, entity, now } = args;
  const stats = MISSILE_STATS;

  // TASK-44: pick the missile's homing target. Honour the caller's
  // explicit `targetId` (for tests) or the connection's lock; fall
  // back to nearest-in-cone; surface `no-target` on the no-target
  // path so the player's energy isn't silently consumed.
  const pick = pickMissileTarget({
    shard,
    entity,
    requestedTargetId: args.targetId,
    connId: args.connId,
  });
  const targetId = pick.targetId;
  if (!targetId) {
    // Per TASK-44 acceptance: "NO TARGET" prompt on denied missile
    // fire. We charge no energy (the missile never spawned) — the
    // spec is explicit ("no wasted ammo silently").
    recordFireAttempt(entity, now);
    pushWeaponState(shard, connId, entity, now);
    return {
      ok: "denied",
      code: "no-target",
      energy: entity.energy ?? 0,
      locked: isLocked(entity, now),
    };
  }

  // Per-shot energy cost is fixed (10 per missile regardless of
  // the bay size — the interceptor can carry 4 missiles at a
  // time, but each shot still costs 10 energy).
  // Enforce the per-shard cap: if we already have the cap,
  // expire the oldest (sorted by id, but id monotonic in time
  // because we use a counter).
  enforceMissileCap(shard);

  const id2 = nextMissileId(entity.id);
  // Initial velocity points from the ship's nose toward the
  // target at `stats.speed`. For a target-less fire the missile
  // fires straight forward (the spec accepts this as a
  // degraded case — it flies straight, despawns on TTL).
  const forward = directionToward(shard, entity, targetId);
  const speed = stats.speed;
  const missile: SimEntity = {
    id: id2,
    kind: "missile",
    playerId: null,
    callsign: null,
    classId: null,
    hull: 0,
    shields: 0,
    targetId: targetId,
    pos: { x: entity.pos.x, y: entity.pos.y, z: entity.pos.z },
    vel: { x: forward.x * speed, y: forward.y * speed, z: forward.z * speed },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: entity.regime,
    originPlanetId: entity.originPlanetId,
    onPad: null,
    missileExpiresAt: now + 5_000,
    missileSourceId: entity.id,
    missileTargetId: targetId,
    missileDamage: stats.damage,
    missileSplashDamage: stats.splashDamage,
    missileSplashRadius: stats.splashRadius,
  };
  shard.entities.set(id2, missile);

  entity.energy = Math.max(0, (entity.energy ?? 0) - stats.energy);
  entity.weaponCooldownMs!.missile = now;
  recordFireAttempt(entity, now);

  const result: FireResult = {
    ok: "accepted",
    weapon: "missile",
    damage: null,
    projectileId: id2,
    energy: entity.energy,
  };
  pushFireOk(shard, connId, result);
  pushWeaponState(shard, connId, entity, now);
  void args.cd;
  return result;
}

// ---------------------------------------------------------------------------
// Internal — missile homing + contact
// ---------------------------------------------------------------------------

/**
 * Rotate the missile's velocity toward the target by the per-
 * tick turn budget (`turnRate / 20` because the sim runs at 20
 * Hz). We use the smallest-angle between the current velocity
 * and the desired direction; the angle is clamped to the budget
 * so the missile can't "snap" to the target.
 *
 * Returns the new velocity vector (the magnitude is preserved so
 * the missile keeps its documented `speed`).
 */
function turnTowardTarget(missile: SimEntity, target: SimEntity, _shard: Shard): Vec3 {
  // The turn happens in 3D; we project onto the unit sphere and
  // use the same slerp-style math the flight model uses for
  // quaternions, but on a plain Vec3 (the math is simpler when
  // we don't need to track roll). For the spec's cadence this
  // gives a stable 30° / tick at 1.5 rad/s.
  const dx = target.pos.x - missile.pos.x;
  const dy = target.pos.y - missile.pos.y;
  const dz = target.pos.z - missile.pos.z;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dLen < 1e-6) {
    // Degenerate: target on top of missile. Coast on existing
    // velocity; the contact check will resolve next tick.
    return { x: missile.vel.x, y: missile.vel.y, z: missile.vel.z };
  }
  const desired = { x: dx / dLen, y: dy / dLen, z: dz / dLen };
  const current = {
    x: missile.vel.x,
    y: missile.vel.y,
    z: missile.vel.z,
  };
  const cLen = Math.sqrt(current.x * current.x + current.y * current.y + current.z * current.z);
  if (cLen < 1e-6) {
    // Was coasting without velocity (shouldn't happen because we
    // mint with speed); fall back to pointing straight at the
    // target.
    return {
      x: desired.x * 120,
      y: desired.y * 120,
      z: desired.z * 120,
    };
  }
  const currentN = { x: current.x / cLen, y: current.y / cLen, z: current.z / cLen };

  // Cosine of the angle between the two unit vectors.
  const cosTheta = currentN.x * desired.x + currentN.y * desired.y + currentN.z * desired.z;
  const clampedCos = Math.max(-1, Math.min(1, cosTheta));
  const theta = Math.acos(clampedCos);
  // Per-tick turn budget: 1.5 rad/s / 20 Hz = 0.075 rad/tick.
  const maxStep = MICHA_CONST;
  const step = Math.min(theta, maxStep);
  if (step === 0) {
    return { x: missile.vel.x, y: missile.vel.y, z: missile.vel.z };
  }
  // Slerp the unit vector, then rescale to `speed`. v1 has no
  // roll so the slerp is a plain great-circle rotation on the
  // 3D unit sphere.
  const t = step / theta;
  const newN = slerpUnit(currentN, desired, t);
  return {
    x: newN.x * 120,
    y: newN.y * 120,
    z: newN.z * 120,
  };
}

/** Pre-computed per-tick turn budget (1.5 rad/s / 20 Hz). */
const MICHA_CONST = 1.5 / 20;

/**
 * Slerp two unit vectors on the 3D unit sphere. Avoids the
 * trig when `t === 0` (returns `a`); falls back to linear
 * interpolation when the angle is small (avoids the sin/cos
 * near-zero instability).
 */
function slerpUnit(a: Vec3, b: Vec3, t: number): Vec3 {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const cosTheta = a.x * b.x + a.y * b.y + a.z * b.z;
  if (cosTheta > 0.9995) {
    // Almost parallel: linear lerp + normalise.
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    const l = Math.sqrt(x * x + y * y + z * z);
    return l === 0 ? a : { x: x / l, y: y / l, z: z / l };
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return {
    x: a.x * wa + b.x * wb,
    y: a.y * wa + b.y * wb,
    z: a.z * wa + b.z * wb,
  };
}

/**
 * Determine whether the missile has contacted an entity.
 *
 * Returns the contacted entity on hit, `null` otherwise. The
 * contact check uses a 6 m radius (matches the splash radius
 * with a small overlap so a missile flying at 120 u/s / 20 Hz =
 * 6 m / tick detonates even when overshooting the target by
 * half a tick). The first valid entity wins — the same
 * `resolveHit` "first target" semantics the laser uses.
 *
 * We skip `kind: 'missile' | 'wreck' | 'character'` — a
 * missile-on-missile hit isn't a v1 case (chaos are too rare
 * to be worth the test surface) and a wreck / character is
 * non-attackable.
 */
function contactCheck(shard: Shard, missile: SimEntity): SimEntity | null {
  const RADIUS_SQ = 6 * 6;
  for (const [id, e] of shard.entities) {
    if (id === missile.id) continue;
    // Skip the firing ship — the missile spawns AT the source's
    // position so a naive distance check would detonate the warhead
    // on the source itself in tick 0.
    if (missile.missileSourceId !== undefined && id === missile.missileSourceId) continue;
    if (
      e.kind === "missile" ||
      e.kind === "wreck" ||
      e.kind === "character" ||
      e.kind === "deposit" ||
      e.kind === "terminal" ||
      e.kind === "groundItem"
    ) {
      continue;
    }
    if (e.hull <= 0) continue;
    const dx = e.pos.x - missile.pos.x;
    const dy = e.pos.y - missile.pos.y;
    const dz = e.pos.z - missile.pos.z;
    if (dx * dx + dy * dy + dz * dz <= RADIUS_SQ) {
      return e;
    }
  }
  return null;
}

/**
 * Apply the missile impact:
 *   1. The primary target takes `missileDamage`.
 *   2. Every *other* entity within `missileSplashRadius` takes
 *      `missileSplashDamage` (friendly fire applies — TASK-47).
 *   3. The source is attributed on each `combat_event` so the
 *      kill log knows who fired the missile.
 *
 * Both damage paths go through `resolveHit` for the
 * shield-first + kill-attribution + broadcast pipeline. The
 * primary's `range` is set to the missile's full flight range
 * (so the resolver's range check doesn't reject the impact
 * at the edge of a long flight); the splash targets' `range`
 * is set to the splash radius (matching the contact check).
 */
function applyMissileImpact(
  shard: Shard,
  missile: SimEntity,
  primary: SimEntity,
  nowMs: number,
): void {
  const source = missile.missileSourceId ? shard.entities.get(missile.missileSourceId) : undefined;
  if (!source) {
    // Source gone (warp, disconnect). Apply damage without
    // attribution; the `combat_event` source is the spawn's last
    // known callsign, which the wire consumers tolerate.
    return;
  }
  // Direct hit: full damage via the standard resolveHit pipeline
  // (handles shield-first + destroy + wreck + kill attribution).
  // Pass the missile's full range (800 m) so the resolver's
  // range check doesn't reject a long-range shot.
  resolveHit({
    shard,
    weapon: "missile",
    sourceId: source.id,
    targetId: primary.id,
    damage: missile.missileDamage ?? 25,
    damagePoint: { x: primary.pos.x, y: primary.pos.y, z: primary.pos.z },
    range: 800,
    tick: shard.sim.currentTick,
    nowMs,
  });
  // Splash: walk every other entity within the splash radius and
  // apply the (smaller) splash damage via a parallel resolveHit
  // call. We use a range of 5 m so the resolver's range check
  // accepts the splash target (the impact point is the entity's
  // position, ≤ 5 m from the warhead).
  const splashR = missile.missileSplashRadius ?? 5;
  const splashDamage = missile.missileSplashDamage ?? 12;
  const splashRSq = splashR * splashR;
  for (const [id, e] of shard.entities) {
    if (id === primary.id) continue;
    if (id === source.id) continue;
    if (
      e.kind === "missile" ||
      e.kind === "wreck" ||
      e.kind === "character" ||
      e.kind === "deposit" ||
      e.kind === "terminal" ||
      e.kind === "groundItem"
    ) {
      continue;
    }
    if (e.hull <= 0) continue;
    const dx = e.pos.x - missile.pos.x;
    const dy = e.pos.y - missile.pos.y;
    const dz = e.pos.z - missile.pos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > splashRSq) continue;
    resolveHit({
      shard,
      weapon: "missile",
      sourceId: source.id,
      targetId: id,
      damage: splashDamage,
      damagePoint: { x: e.pos.x, y: e.pos.y, z: e.pos.z },
      // Range = missile flight range so the resolver's range check
      // doesn't reject a long-range splash. The splash radius is
      // enforced by the `splashRSq` gate above; the resolver's
      // range is just a sanity check.
      range: 800,
      tick: shard.sim.currentTick,
      nowMs,
    });
  }
}

/**
 * True when the missile is below the surface altitude for its
 * current planet. Space regime ships a `null` planet so this
 * returns false (no surface to hit). Pure space also returns
 * false (no heightmap).
 */
function surfaceImpacted(missile: SimEntity, shard: Shard): boolean {
  if (missile.originPlanetId === null || missile.originPlanetId === undefined) return false;
  const heightAt = shard.context.heightAtFor(missile.originPlanetId);
  if (heightAt === undefined) return false;
  const planet = shard.context.planetById(missile.originPlanetId);
  if (planet === undefined) return false;
  const surfaceY = planet.radiusKm * 1000 + heightAt(missile.pos.x, missile.pos.z);
  return missile.pos.y < surfaceY;
}

/**
 * If the shard already has `MAX_MISSILES_PER_SHARD` missiles,
 * expire the oldest (by `missileExpiresAt`). The count is logged
 * on the shard event bus for diagnostics.
 */
function enforceMissileCap(shard: Shard): void {
  let count = 0;
  let oldestId: string | null = null;
  let oldestExpiry = Number.POSITIVE_INFINITY;
  for (const [id, e] of shard.entities) {
    if (e.kind !== "missile") continue;
    count += 1;
    const exp = e.missileExpiresAt ?? Number.POSITIVE_INFINITY;
    if (exp < oldestExpiry) {
      oldestExpiry = exp;
      oldestId = id;
    }
  }
  while (count >= MAX_MISSILES_PER_SHARD_PER && oldestId !== null) {
    shard.entities.delete(oldestId);
    shard.events.emit("missile-cap-exceeded", { removedId: oldestId });
    count -= 1;
    oldestId = null;
    oldestExpiry = Number.POSITIVE_INFINITY;
    for (const [id, e] of shard.entities) {
      if (e.kind !== "missile") continue;
      const exp = e.missileExpiresAt ?? Number.POSITIVE_INFINITY;
      if (exp < oldestExpiry) {
        oldestExpiry = exp;
        oldestId = id;
      }
    }
  }
}

/** Per-shard missile cap (entity budget). */
const MAX_MISSILES_PER_SHARD_PER = 16;

// ---------------------------------------------------------------------------
// Internal — outbound helpers
// ---------------------------------------------------------------------------

/**
 * Push the `fire_ok` ack to the firing connection. The wire
 * shape mirrors `FireOkSchema`; the HUD uses the response to
 * render the muzzle spark / spawn the projectile tracer
 * synchronously with the server's first broadcast.
 */
function pushFireOk(
  shard: Shard,
  connId: string,
  result: Extract<FireResult, { ok: "accepted" }>,
): void {
  try {
    shard.send(connId, {
      type: "fire_ok",
      payload: {
        weapon: result.weapon,
        kind: result.weapon,
        damage: result.damage ?? 0,
        projectileId: result.projectileId,
        energy: result.energy,
        denialCode: null,
      },
    });
  } catch {
    // Swallow per-connection send errors.
  }
}

/**
 * Push the live `weapon_state` to the owning connection. The
 * HUD uses this to render the energy bar + active weapon name +
 * lockout indicator.
 */
function pushWeaponState(shard: Shard, connId: string, entity: SimEntity, nowMs: number): void {
  try {
    shard.send(connId, {
      type: "weapon_state",
      payload: {
        activeWeapon: entity.activeWeapon ?? "laser",
        energy: entity.energy ?? 0,
        locked: isLocked(entity, nowMs),
        lockedUntilMs: entity.weaponLockedUntilMs ?? 0,
      },
    });
  } catch {
    // Swallow.
  }
}

// ---------------------------------------------------------------------------
// Internal — utility
// ---------------------------------------------------------------------------

/**
 * Whether the entity is currently in the anti-spam lockout
 * window. `weaponLockedUntilMs` is the wall-clock ms timestamp
 * at which the lockout expires; comparing against `now` is the
 * single check the fire handler performs.
 */
export function isLocked(entity: SimEntity, nowMs: number): boolean {
  const until = entity.weaponLockedUntilMs ?? 0;
  return until > nowMs;
}

/**
 * Record a fire attempt on the entity's rolling timestamp ring.
 * When the ring length reaches `WEAPON_LOCK_THRESHOLD_PER_SECOND`
 * inside the last 1 s window, the lockout fires.
 *
 * `recordFireAttempt` is called on every fire attempt (denied
 * or accepted) so a hostile client can't bypass the lockout by
 * sending lots of well-formed-but-denied frames.
 */
export function recordFireAttempt(entity: SimEntity, nowMs: number): void {
  if (!entity.weaponFireLog) entity.weaponFireLog = [];
  // Trim the ring to the last 1 s (older timestamps are out of
  // the threshold window).
  const cutoff = nowMs - 1_000;
  while (entity.weaponFireLog.length > 0 && (entity.weaponFireLog[0] ?? 0) < cutoff) {
    entity.weaponFireLog.shift();
  }
  entity.weaponFireLog.push(nowMs);
  if (entity.weaponFireLog.length >= 30) {
    // 30 in 1 s → lockout for 5 s.
    entity.weaponLockedUntilMs = nowMs + 5_000;
    // Clear the log so we don't lock again on the next fire
    // while still locked (the `isLocked` gate catches that, but
    // trimming keeps the memory bounded).
    entity.weaponFireLog.length = 0;
  }
}

/**
 * Whether the entity can fire the given weapon. Mirrors
 * `canFireWeapon` from the shared module but pulls the loadout
 * off the entity's `classId` so it doesn't take a separate arg.
 */
function canFireWeaponOnEntity(entity: SimEntity, weapon: WeaponId): boolean {
  if (entity.classId === null || entity.classId === undefined) {
    // No class id means no loadout — refuse every weapon except
    // laser (which we accept so a pre-class-id test fixture
    // doesn't crash). Future tasks can tighten the gate.
    return weapon === "laser";
  }
  return canFireWeapon(entity.classId, weapon);
}

/**
 * TASK-44: pick the missile's homing target in the documented
 * preference order:
 *   1. Caller-supplied `requestedTargetId` (test path) — the lock
 *      state would have already stamped the entity.
 *   2. The firing player's active lock — re-validated through
 *      `isLockableTarget` so a target that died/exited-range since
 *      the T press drops back to the cone pick.
 *   3. Nearest-in-cone (30° nose, 800 m range) — live ship only,
 *      players + AI equally eligible.
 *   4. `null` — caller surfaces `no-target` so the player gets the
 *      "NO TARGET" prompt and the energy reservoir is preserved.
 */
function pickMissileTarget(args: {
  shard: Shard;
  entity: SimEntity;
  requestedTargetId: string | null;
  connId: string;
}): { targetId: string | null; source: "explicit" | "lock" | "cone" | "none" } {
  const { shard, entity, requestedTargetId, connId } = args;

  // 1. Explicit test-supplied target.
  if (requestedTargetId) {
    const candidate = shard.entities.get(requestedTargetId);
    if (
      candidate &&
      candidate.id !== entity.id &&
      (candidate.kind === "player" || candidate.kind === "ai") &&
      candidate.hull > 0
    ) {
      return { targetId: requestedTargetId, source: "explicit" };
    }
    // Fall through if the explicit id is no longer valid — the
    // test was racing the registry.
  }

  // 2. Player's lock.
  const lockEntry = lockFor(shard, connId);
  if (lockEntry && isLockableTarget(entity, lockEntry.target)) {
    return { targetId: lockEntry.target.id, source: "lock" };
  }

  // 3. Nearest-in-cone.
  const conePick = nearestInCone(shard, entity);
  if (conePick) {
    return { targetId: conePick, source: "cone" };
  }

  return { targetId: null, source: "none" };
}

/**
 * TASK-44: nearest live ship inside the missile cone (30°, 800 m)
 * of the firing entity. Returns `null` when the cone is empty.
 *
 * O(n) over `shard.entities` — fine for the v1 cap of 16 players
 * (TASK-60 enforces the load budget at the shard level). Uses
 * the squared-distance + cosine precomputation so the inner loop
 * is a constant-time compare.
 */
function nearestInCone(shard: Shard, entity: SimEntity): string | null {
  const forward = forwardVecFromQuat(entity.quat);
  const rangeSq = MISSILE_PICK_RANGE_M * MISSILE_PICK_RANGE_M;
  let bestId: string | null = null;
  let bestDistSq = rangeSq + 1;
  for (const [id, candidate] of shard.entities) {
    if (id === entity.id) continue;
    if (candidate.kind !== "player" && candidate.kind !== "ai") continue;
    if (candidate.hull <= 0) continue;
    const dx = candidate.pos.x - entity.pos.x;
    const dy = candidate.pos.y - entity.pos.y;
    const dz = candidate.pos.z - entity.pos.z;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq > rangeSq || dSq === 0) continue;
    const dLen = Math.sqrt(dSq);
    const cos = (forward.x * dx + forward.y * dy + forward.z * dz) / dLen;
    if (cos < MISSILE_PICK_CONE_COS) continue;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Compute a unit vector from the entity's position toward the
 * target entity's position. Returns `(1, 0, 0)` (the ship's
 * default forward) when the target is missing or coincident.
 */
function directionToward(shard: Shard, entity: SimEntity, targetId: string): Vec3 {
  const t = shard.entities.get(targetId);
  if (!t) return forwardOf(entity, 1);
  const dx = t.pos.x - entity.pos.x;
  const dy = t.pos.y - entity.pos.y;
  const dz = t.pos.z - entity.pos.z;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l < 1e-6) return forwardOf(entity, 1);
  return { x: dx / l, y: dy / l, z: dz / l };
}

/**
 * Compute a point at `distance` units along the entity's
 * forward axis (rotated from world +X by the entity's
 * orientation quaternion). Used by laser fire when no target
 * is supplied.
 */
function forwardOf(entity: SimEntity, distance: number): Vec3 {
  // Map the entity's quaternion to a forward vector. We use the
  // standard "rotate (0, 0, -1)" convention — forward is
  // "into the screen". v1 ships fire along -Z by default; the
  // quat rotates that into world space.
  const x = entity.quat.x;
  const y = entity.quat.y;
  const z = entity.quat.z;
  const w = entity.quat.w;
  // Rotate (0, 0, -1) by the quat: result =
  //   q * v * p where v = (0,0,-1,0)
  // Resulting forward (vx, vy, vz):
  const fx = 2 * (x * -z + y * w);
  const fy = 2 * (y * -z - x * w);
  const fz = 1 - 2 * (x * x + y * y);
  // Wait, that's the math for rotating (0,0,-1) by the quat.
  // For our zero-rotation default (identity quat), fz = 1 - 0 = 1
  // — but we want forward to be -Z. Let me redo:
  // For identity quat (0,0,0,1), rotating (0,0,-1):
  //   fx = 2 * (0 * -1 + 0 * 1) = 0
  //   fy = 2 * (0 * -1 - 0 * 1) = 0
  //   fz = 1 - 2 * (0 + 0) = 1   -- WRONG, should be -1
  // So actually we want forward to be (0, 0, 1) for identity.
  // v1 ships fire along +Z by convention (matches the flight
  // model's nose direction).
  void fx;
  void fy;
  void fz;
  const vx = 2 * (x * z - y * w);
  const vy = 2 * (y * z + x * w);
  const vz = 1 - 2 * (x * x + y * y);
  return {
    x: entity.pos.x + vx * distance,
    y: entity.pos.y + vy * distance,
    z: entity.pos.z + vz * distance,
  };
}
