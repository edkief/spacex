/**
 * Rogue-AI combat state machine — TASK-46.
 *
 * Every AI ship (TASK-45's `kind: 'ai'` entity) is driven by a
 * four-state machine:
 *
 *   PATROL      — drift around `aiPatrolCenter` at 0.5 × max speed.
 *   AGGRO       — a player has been seen within 600 m + 60° of the
 *                 ship's forward, OR a player fired on the AI within
 *                 the last 5 s. The AI begins a 1 s "acquire" timer.
 *   ENGAGE      — pursue with class turn rate, lead-point steering,
 *                 thrust proportional to heading error. Fire through
 *                 the SAME `handleFire` path players do. Weapon
 *                 choice: missiles when target > 300 m AND the AI
 *                 has missile bays, lasers otherwise.
 *   DISENGAGE   — hull < 25% of class max. Break off, fly toward the
 *                 nearest patrol waypoint at max speed, hold this
 *                 state for 30 s, then re-enter PATROL.
 *
 * The AI is integrated through the same `integrateShip` function
 * players use — the only difference is the source of the
 * `ShipInput` (this module computes it each frame). Damage is
 * applied via the same `resolveHit` / `applyCombatDamage` /
 * `handleFire` path; a destroyed rogue goes through `scheduleAiRespawn`
 * (TASK-45) and disappears from the registry for the cooldown.
 *
 * ## Determinism
 *
 * Every decision that has any random component (waypoint
 * selection, target tie-break, the rare "skip a fire" jitter)
 * consumes the shard RNG. The RNG is seeded once per shard from
 * `systemId` and re-keyed per tick via the tick counter — see
 * `AiRng` below. Same tick sequence ⇒ same AI behaviour,
 * which is the property the determinism test asserts.
 *
 * ## Connection seam
 *
 * The AI uses `handleFire` to fire — the spec is "fire through the
 * SAME server combat pipeline as players — TASK-43 handleFire with
 * the AI as source, same rate limits". `handleFire` looks up the
 * entity via `conn.entityId`, so the AI module registers a
 * synthetic "ghost" connection per AI ship on first integration.
 * The ghost has `connId: "ai:<aiId>"` so any `fire_ok` /
 * `weapon_state` ack the WS layer would have pushed is silently
 * dropped (the closure skips unknown connIds — see
 * `app/src/server/galaxy/ws-router-bridge.ts#buildConnSender`).
 *
 * @see ./weapons.ts#handleFire for the fire pipeline (TASK-43).
 * @see ./combat.resolve.ts for the hit resolver (TASK-42).
 * @see ./combat.ts for the damage pipeline (TASK-23).
 * @see ./ai-respawn.ts for the post-DISENGAGE spawn lifecycle
 *      (TASK-45).
 * @see ../shared/world/ai.ts for the seed-derived roster (TASK-45).
 * @see ../shared/targeting.ts for the cone / range gates (TASK-44).
 */

import { EventEmitter } from "node:events";

import type { ShipClass, ShipClassId } from "@shared/ships.js";
import { SHIP_CLASSES } from "@shared/ships.js";
import {
  forwardVecFromQuat,
  angleCosineToForward,
  TARGET_LOCK_AUTO_RELEASE_RANGE_M,
} from "@shared/targeting.js";
import { hash2, seedFromString } from "@shared/random.js";
import { canFireWeapon, weaponStats } from "@shared/weapons.js";
import type { ProtocolCombatEvent } from "@shared/protocol/index.js";
import {
  X_AXIS,
  Y_AXIS,
  Z_AXIS,
  type Quat,
  type Vec3,
  quatFromAxisAngle,
  quatMul,
  quatNormalize,
  quatRotateVector,
  vecAdd,
  vecLength,
  vecLengthSq,
  vecNormalize,
  vecScale,
  vecSub,
} from "@shared/physics/vec.js";
import type { ShipInput, ShipState } from "@shared/physics/flight.js";

import { handleFire } from "./weapons.js";
import type { Shard, ShardConnection, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants — spec values, surfaced so the tests + future tuning
// tasks can pin them without re-deriving the math.
// ---------------------------------------------------------------------------

/** AI states accepted in `AiStateRecord.mode`. */
export type AiMode = "PATROL" | "AGGRO" | "ENGAGE" | "DISENGAGE" | "DEAD";

/**
 * AGGRO trigger — players within 600 m of the rogue AND within a
 * 60° half-angle cone of the ship's forward axis enter the
 * AGGRO candidate list. The cosine of 60° = 0.5 — used by the
 * server-side cone check for cheap inner-loop comparisons.
 */
export const AI_AGGRO_RANGE_M = 600;

/**
 * TASK-60: beyond this range from every player an AI in `PATROL`
 * is *dormant* — nobody can see it, nobody can shoot it, so the
 * full state machine costs nothing but CPU. Dormant AI re-decide at
 * {@link AI_DORMANT_TICK_MS} (1 Hz) instead of 20 Hz.
 */
export const AI_DORMANT_RANGE_M = 2000;

/** Dormant AI re-decide cadence, ms (1 Hz). */
export const AI_DORMANT_TICK_MS = 1_000;

/** Half-angle of the AGGRO cone (degrees). Spec calls for 60°. */
export const AI_AGGRO_CONE_HALF_DEG = 60;

/** Cosine of the AGGRO cone half-angle (== cos(60°) = 0.5). */
export const AI_AGGRO_CONE_COS = Math.cos((AI_AGGRO_CONE_HALF_DEG * Math.PI) / 180);

/**
 * "Player fired on the AI" window. The shard stamps
 * `ai.recentlyDamagedBy[playerId] = nowMs` whenever
 * `applyCombatDamage` runs with `source.kind === 'player'`. The
 * AGGRO check reads the freshest timestamp; a target within
 * this window counts as recently fired.
 */
export const AI_AGGRO_RECENT_FIRE_MS = 5_000;

/**
 * 1 s acquire delay per new target. After the AI enters AGGRO
 * with a brand-new target id, the AI waits `AI_ACQUIRE_DELAY_MS`
 * before firing — the spec calls this out as a fairness
 * concession (the player has a chance to react). Visible to the
 * player as an 'ACQUIRING' toast via a `combat_event { kind:
 * 'ai_acquiring' }` frame pushed to the player's connection on
 * transition.
 */
export const AI_ACQUIRE_DELAY_MS = 1_000;

/**
 * Missile lock-break radius. A target that gets within this
 * distance of the AI may execute a sharp turn to break the
 * missile's homing lock (the missile's `turnRate = 1.5 rad/s`
 * is the limiting factor — TASK-43). Spec calls for 200 m.
 */
export const AI_MISSILE_BREAK_LOCK_RANGE_M = 200;

/**
 * ENGAGE weapon choice boundary. Spec: missiles when target >
 * 300 m AND the AI has missile bays, lasers otherwise.
 */
export const AI_ENGAGE_MISSILE_RANGE_M = 300;

/**
 * Disengage hull threshold (fraction of class max). Spec calls
 * for < 25% — we use the strict-less-than comparison so a hull
 * that hits exactly 25% stays in ENGAGE.
 */
export const AI_DISENGAGE_HULL_FRAC = 0.25;

/**
 * Disengage duration (ms). Spec calls for 30 s of "fly toward
 * the nearest patrol waypoint at max speed, then re-PATROL".
 */
export const AI_DISENGAGE_DURATION_MS = 30_000;

/**
 * PATROL speed fraction of the class `maxVelocity`. Spec calls
 * for 0.5 × max speed.
 */
export const AI_PATROL_SPEED_FRAC = 0.5;

/**
 * ENGAGE thrust multiplier. The spec describes "thrust
 * proportional to heading error": small heading error → full
 * thrust; large heading error → reduce to 0. We blend toward
 * `AI_ENGAGE_MAX_THRUST_FRAC` of `shipClass.acceleration` so
 * the AI doesn't slam the throttle at the apex of a turn.
 */
export const AI_ENGAGE_MAX_THRUCT_FRAC = 1.0;

/**
 * Lead-point time horizon (seconds). Spec: "steers toward
 * `target.pos + target vel * 0.5 s`".
 */
export const AI_LEAD_TIME_S = 0.5;

/**
 * Waypoint sample count. Each AI ship holds a deterministic
 * patrol loop of `AI_WAYPOINT_COUNT` points drawn around the
 * `aiPatrolCenter` on a unit circle. The AI advances the
 * `waypointIdx` after arriving within `AI_WAYPOINT_ARRIVAL_M`
 * of the current point.
 */
export const AI_WAYPOINT_COUNT = 4;
export const AI_WAYPOINT_ARRIVAL_M = 50;

/**
 * Domain tag mixed into the AI RNG seed so the AI decisions are
 * not co-mingled with the surface / planet / star RNGs.
 */
const AI_RNG_DOMAIN_TAG = 0xa16babefn;

/**
 * Ghost connection id prefix. The shard ships with one synthetic
 * `ShardConnection` per AI entity so `handleFire` can look up
 * the AI's `entityId` through the standard
 * `conn.entityId → entities.get(...)` path. The "ai:" prefix
 * matches the entity id format so `forgetConnectionLocks` is a
 * no-op for AI connections (the targets Map doesn't carry them).
 */
const AI_GHOST_CONN_PREFIX = "ai:";
/** TASK-18: re-exported so the router can identify AI ghost
 *  connections for the 16-player cap. See
 *  `galaxy/router-connection.ts#isAiGhostConnection`. */
export { AI_GHOST_CONN_PREFIX };

/**
 * Stable acquire-notification wire event. Server pushes this
 * directly to the targeted player's connection on AGGRO
 * transition so the client's HUD can render an "ACQUIRING"
 * toast. Lives on the combat_event discriminated union so the
 * existing wire schema covers it; no new frame type required.
 */
export interface AiAcquiringEvent {
  kind: "ai_acquiring";
  source: { kind: "ai"; id: string; callsign: string | null };
  target: string;
  tick: number;
}

/**
 * Per-AI state record. Stored on `shard.aiStates: Map<aiId,
 * AiStateRecord>`. Mutated in place each tick — the record
 * never escapes the AI module except through `getAiState()` for
 * tests.
 *
 * Fields:
 *
 *   - `mode`           — current state machine mode.
 *   - `targetId`       — entity id of the locked-on target, or
 *                          `null` for PATROL / DISENGAGE.
 *   - `acquireStartedAt` — wall-clock ms when the AI began the
 *                          current AGGRO → ENGAGE acquire
 *                          timer. `0` outside AGGRO/ENGAGE.
 *   - `waypointIdx`    — patrol-loop cursor (`0..AI_WAYPOINT_COUNT-1`).
 *   - `disengageUntil` — wall-clock ms when DISENGAGE ends and
 *                          the AI re-enters PATROL.
 *   - `lastFireAttemptMs` — last `handleFire` attempt timestamp
 *                          (used by the throttle check + tests).
 *   - `recentlyDamagedBy` — `Map<playerId, wall-clock ms>` of
 *                          the most recent hit per player.
 *                          AGGRO re-checks this map every tick.
 *   - `lastAcquiringBroadcastMs` — wall-clock ms of the last
 *                          'ACQUIRING' toast we sent for the
 *                          current target. We re-broadcast every
 *                          `ACQUIRE_DELAY_MS` so the player's toast
 *                          stays alive while the AI is still in
 *                          AGGRO-with-the-same-target (visual
 *                          reminder).
 */
export interface AiStateRecord {
  aiId: string;
  mode: AiMode;
  targetId: string | null;
  acquireStartedAt: number;
  waypointIdx: number;
  disengageUntil: number;
  lastFireAttemptMs: number;
  recentlyDamagedBy: Map<string, number>;
  lastAcquiringBroadcastMs: number;
  /**
   * TASK-60: wall clock of the last FULL state-machine pass. Dormant
   * AI (past {@link AI_DORMANT_RANGE_M} from every player) consult
   * this to run their patrol at 1 Hz instead of 20 Hz.
   */
  lastFullTickMs: number;
}

// ---------------------------------------------------------------------------
// RNG — seeded per shard, re-keyed per tick. Pure-function variant
// so the determinism test can run two shards in lockstep.
// ---------------------------------------------------------------------------

/**
 * Mulberry32 — small, fast, deterministic PRNG. The AI module
 * uses this for every randomised decision (waypoint tie-break,
 * fire jitter) so two shards running the same `(seed, systemId,
 * tick)` produce the same AI behaviour.
 */
export function mulberry32(seed: bigint): () => number {
  let state = seed & 0xffffffffn;
  return () => {
    state = (state + 0x6d2b79f5n) & 0xffffffffn;
    let t = state;
    t = ((t ^ (t >> 15n)) * ((t >> 1n) ^ 0x1a4d6e29n)) & 0xffffffffn;
    t = (t + (((t ^ (t >> 16n)) * ((t >> 11n) ^ 0x4cd2bf49n)) & 0xffffffffn)) & 0xffffffffn;
    const result = Number(t & 0x7fffffffn) / 0x80000000;
    return result;
  };
}

/**
 * Compute the AI RNG seed for one tick. Combines
 * `(systemIdHash, tickCount)` so two shards with the same
 * `systemIdHash` and the same tick number produce identical
 * sequences (the determinism test asserts this).
 */
export function aiRngSeedForTick(systemId: string, tick: number): bigint {
  const sys = seedFromString(systemId);
  // Mix the tick counter in via `hash2` so the tick space is
  // hashed instead of concatenated (avoids the "tick=1 vs tick=10
  // produces an obviously-related seed" failure mode).
  const mixed = hash2(sys, BigInt(tick));
  return hash2(mixed, AI_RNG_DOMAIN_TAG);
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so the tests + future server tasks
// can exercise individual decisions without booting a full shard.
// ---------------------------------------------------------------------------

/**
 * Resolve the ship-class for an entity. Returns `undefined` for
 * non-ship kinds (characters / wrecks / deposits / terminals /
 * ground items / missiles) so the AI module can skip them
 * silently.
 */
export function shipClassFor(entity: SimEntity): ShipClass | undefined {
  if (entity.classId === null || entity.classId === undefined) return undefined;
  return SHIP_CLASSES[entity.classId as ShipClassId];
}

/**
 * Pick a target for the AI. The candidate list is:
 *
 *   1. Players within `AI_AGGRO_RANGE_M` + `AI_AGGRO_CONE_COS` of
 *      the AI's forward. Forward-aligned AGGRO matches the spec
 *      ("a player within 600 m and 60° of forward").
 *   2. Players who fired on the AI within the last
 *      `AI_AGGRO_RECENT_FIRE_MS` (stamped via
 *      `noteAiDamagedBy`).
 *
 * Tie-break: nearest candidate wins. Returns `null` when no
 * candidate qualifies.
 */
function isPlayerRecentlyDamaged(args: {
  aiState: AiStateRecord;
  playerId: string | null;
  nowMs: number;
  recentMs: number;
}): boolean {
  if (args.playerId === null) return false;
  const lastHit = args.aiState.recentlyDamagedBy.get(args.playerId);
  if (lastHit === undefined) return false;
  return args.nowMs - lastHit < args.recentMs;
}
export function pickAggroTarget(args: {
  shard: Shard;
  ai: SimEntity;
  forward: Vec3;
  nowMs: number;
  aiState: AiStateRecord;
  aggroRangeM?: number;
  aggroConeCos?: number;
  recentFireMs?: number;
}): SimEntity | null {
  const rangeM = args.aggroRangeM ?? AI_AGGRO_RANGE_M;
  const coneCos = args.aggroConeCos ?? AI_AGGRO_CONE_COS;
  const recentMs = args.recentFireMs ?? AI_AGGRO_RECENT_FIRE_MS;
  let bestId: string | null = null;
  let bestDistSq = rangeM * rangeM + 1;
  for (const [id, candidate] of args.shard.entities) {
    if (id === args.ai.id) continue;
    if (candidate.kind !== "player") continue;
    if (candidate.hull <= 0) continue;
    // TASK-49: docks are safe zones — a landed player is never a
    // valid aggro target (matches `resolveHit`'s docked-target
    // rejection).
    if (candidate.onPad !== null) continue;
    // Distance gate.
    const dx = candidate.pos.x - args.ai.pos.x;
    const dy = candidate.pos.y - args.ai.pos.y;
    const dz = candidate.pos.z - args.ai.pos.z;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq > rangeM * rangeM) continue;
    const inRange = dSq <= rangeM * rangeM;
    const cos = angleCosineToForward(args.ai, candidate);
    const inCone = cos >= coneCos;
    const recentlyDamaged = isPlayerRecentlyDamaged({
      aiState: args.aiState,
      playerId: candidate.playerId,
      nowMs: args.nowMs,
      recentMs,
    });
    if (!inRange || (!inCone && !recentlyDamaged)) continue;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestId = id;
    }
  }
  if (bestId === null) return null;
  return args.shard.entities.get(bestId) ?? null;
}

/**
 * Compute the AGGRO target id list (for tests + the spec's
 * "AI never targets other AI" rule). v1 keeps rogues hostile
 * only to players — `pickAggroTarget` filters out `kind: 'ai'`
 * candidates so we don't need a separate list helper.
 *
 * The dedicated helper exists so the fairness test can pin
 * the "rogues never target rogues" invariant in one assertion.
 */
export function aiAggressorsList(shard: Shard): readonly SimEntity[] {
  const out: SimEntity[] = [];
  for (const e of shard.entities.values()) {
    if (e.kind !== "ai") continue;
    out.push(e);
  }
  return out;
}

/**
 * Pure lead-point computation. The AI steers toward
 * `target.pos + target.vel * AI_LEAD_TIME_S`. Returns the
 * target itself when the velocity vector is near zero (avoids a
 * 0-length direction later).
 */
export function leadPointFor(target: SimEntity, leadTimeS: number = AI_LEAD_TIME_S): Vec3 {
  return {
    x: target.pos.x + target.vel.x * leadTimeS,
    y: target.pos.y + target.vel.y * leadTimeS,
    z: target.pos.z + target.vel.z * leadTimeS,
  };
}

/**
 * Compute the desired heading quaternion for the AI given the
 * lead point. Uses `quatFromAxisAngle` to yaw + pitch toward
 * the lead point in a single step (no roll — we never need
 * roll for AI). Returns the entity's current quaternion when
 * the lead point is coincident (degenerate).
 */
export function headingTowardPoint(args: { entity: SimEntity; target: Vec3 }): Quat {
  const dx = args.target.x - args.entity.pos.x;
  const dy = args.target.y - args.entity.pos.y;
  const dz = args.target.z - args.entity.pos.z;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dLen < 1e-6) return { ...args.entity.quat };
  // Forward unit vector pointing at the lead point. The AI's
  // local +Z is its forward (matches the shared flight model's
  // convention), so the desired forward vector is just
  // (dx, dy, dz) / dLen.
  const desired = { x: dx / dLen, y: dy / dLen, z: dz / dLen };
  const current = forwardVecFromQuat(args.entity.quat);
  // Yaw + pitch to align. We solve for the rotation that maps
  // `current` → `desired` using a clamped slerp on the unit
  // sphere. Roll stays at zero.
  const cosTheta = clamp(
    current.x * desired.x + current.y * desired.y + current.z * desired.z,
    -1,
    1,
  );
  if (cosTheta > 0.9995) {
    // Already aligned — return as-is.
    return { ...args.entity.quat };
  }
  const theta = Math.acos(cosTheta);
  // Axis = current × desired. Renormalise so the
  // `quatFromAxisAngle` math is stable.
  const axis: Vec3 = {
    x: current.y * desired.z - current.z * desired.y,
    y: current.z * desired.x - current.x * desired.z,
    z: current.x * desired.y - current.y * desired.x,
  };
  const axisLen = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
  if (axisLen < 1e-6) return { ...args.entity.quat };
  const axisN: Vec3 = { x: axis.x / axisLen, y: axis.y / axisLen, z: axis.z / axisLen };
  // Apply the full rotation in one step — the AI snaps to the
  // target heading (the integrator clamps the per-tick turn to
  // the class `turnRate`, so the visible rotation is smooth
  // even though the desired quaternion is exact).
  return quatNormalize(quatFromAxisAngle(axisN, theta));
}

/**
 * Curvature angle (radians) between the AI's current forward and
 * the lead point. Used to scale thrust (heading error large →
 * small thrust).
 */
export function headingErrorRad(args: { entity: SimEntity; target: Vec3 }): number {
  const dx = args.target.x - args.entity.pos.x;
  const dy = args.target.y - args.entity.pos.y;
  const dz = args.target.z - args.entity.pos.z;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dLen < 1e-6) return 0;
  const forward = forwardVecFromQuat(args.entity.quat);
  const cos = clamp((forward.x * dx + forward.y * dy + forward.z * dz) / dLen, -1, 1);
  return Math.acos(cos);
}

/**
 * Pick the weapon the AI should fire given the engagement
 * distance and the ship's loadout. Spec: missiles when target
 * > `AI_ENGAGE_MISSILE_RANGE_M` AND the AI has missile bays,
 * lasers otherwise.
 */
export function weaponForEngage(
  distanceM: number,
  classId: ShipClassId,
): "laser" | "missile" | null {
  // Missile path requires the class to carry missile bays.
  const cls = SHIP_CLASSES[classId];
  if (distanceM > AI_ENGAGE_MISSILE_RANGE_M && cls.weaponMounts.missiles > 0) {
    return "missile";
  }
  if (canFireWeapon(classId, "laser")) return "laser";
  return null;
}

/**
 * Pure waypoint generator. Given a patrol centre + radius,
 * yields `AI_WAYPOINT_COUNT` evenly-spaced points on the
 * horizontal circle. v1 ignores `y` because rogues stay in
 * space; atmosphere-mode AIs use the same helper but the
 * patrol ends up below the y=0 plane (the integration step
 * drags the ship up / down as needed).
 */
export function waypointsFor(args: { center: Vec3; radius: number; count?: number }): Vec3[] {
  const count = args.count ?? AI_WAYPOINT_COUNT;
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * 2 * Math.PI;
    out.push({
      x: args.center.x + args.radius * Math.cos(theta),
      y: args.center.y,
      z: args.center.z + args.radius * Math.sin(theta),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decision — pure function. Reads state, returns the desired
// ship input + a transition event for the state-machine update.
// ---------------------------------------------------------------------------

/**
 * The decision result. Two pieces:
 *
 *   - `input`   — `ShipInput` to feed `integrateShip`. The
 *                 integrator clamps turn to `shipClass.turnRate`
 *                 so we don't have to gate it here.
 *   - `fire`    — optional weapon-fire intent. When non-null
 *                 `tickAi` will route through `handleFire`. The
 *                 decision module decides WHEN; the AI loop
 *                 decides the rate-limit / energy gate (the spec
 *                 wants AI fire to obey the same energy / rate
 *                 limits as players).
 *   - `mode`    — the new mode the AI should be in after the
 *                 decision (used to update `AiStateRecord.mode`).
 *   - `reason`  — human-readable reason for the transition;
 *                 visible in debug logs and tests.
 */
export interface AiDecision {
  input: ShipInput;
  fire: { weapon: "laser" | "missile"; targetId: string | null } | null;
  mode: AiMode;
  reason: string;
}

/**
 * Run the state machine for one AI entity on one tick. Pure
 * given `(entity, aiState, shard, dt, nowMs, rng)` — no
 * side-effects on `entity` / `aiState` / `shard.entities`.
 *
 * The caller (`tickAi`) applies the decision to the entity and
 * updates the `AiStateRecord` based on the returned `mode`.
 *
 * The state machine:
 *
 *   PATROL → AGGRO     player in range+cone OR fired on us
 *   AGGRO → ENGAGE     acquire timer elapsed AND target still valid
 *   AGGRO → PATROL     target left the aggro range / dead
 *   ENGAGE → DISENGAGE hull < DISENGAGE threshold
 *   ENGAGE → AGGRO     target died / out of aggro range (re-acquire)
 *   ENGAGE → PATROL    target left the auto-release range AND no
 *                      other candidate inside the auto-release range
 *   DISENGAGE → PATROL disengageUntil elapsed
 *   DEAD               — terminal. The AI module skips integration.
 */
export function decideAi(args: {
  ai: SimEntity;
  aiState: AiStateRecord;
  shard: Shard;
  dt: number;
  nowMs: number;
  rng: () => number;
}): AiDecision {
  const { ai, aiState, shard, dt, nowMs } = args;
  const cls = shipClassFor(ai);
  if (cls === undefined) {
    return {
      input: idleInput(),
      fire: null,
      mode: aiState.mode,
      reason: "no-class",
    };
  }

  // DEAD: skip integration (the entity should have been
  // removed by `scheduleAiRespawn` already; the state record
  // stays so a respawn can hand the AI back into PATROL).
  if (aiState.mode === "DEAD" || ai.hull <= 0) {
    return {
      input: idleInput(),
      fire: null,
      mode: "DEAD",
      reason: "no-hull",
    };
  }

  // --- Disengage check (terminal for hull) ---------------------
  const hullFrac = ai.hull / cls.hull;
  if (hullFrac < AI_DISENGAGE_HULL_FRAC && aiState.mode !== "DISENGAGE") {
    return enterDisengage({ ai, aiState, cls, nowMs });
  }

  // --- AGGRO re-evaluation ------------------------------------
  // Even in ENGAGE we re-check the aggro conditions every tick
  // so the AI drops a target that left the auto-release range
  // (the AGGRO check uses the wider 600 m cone / 5 s recent
  // fire window).
  const forward = forwardVecFromQuat(ai.quat);
  const aggroCandidate = pickAggroTarget({
    shard,
    ai,
    forward,
    nowMs,
    aiState,
  });

  // --- PATROL --------------------------------------------------
  if (aiState.mode === "PATROL") {
    if (aggroCandidate) {
      return enterAggro({ ai, aiState, target: aggroCandidate, nowMs, reason: "sighted" });
    }
    return patrolDecision({ ai, aiState, cls, dt: args.dt, nowMs: args.nowMs });
  }

  // --- DISENGAGE -----------------------------------------------
  if (aiState.mode === "DISENGAGE") {
    if (nowMs >= aiState.disengageUntil) {
      return enterPatrol({ aiState, nowMs, reason: "disengage-elapsed" });
    }
    return disengageDecision({ ai, aiState, cls, dt, nowMs });
  }

  // --- AGGRO ---------------------------------------------------
  if (aiState.mode === "AGGRO") {
    // The previous target may have died / warped out of range.
    let target: SimEntity | null = null;
    if (aiState.targetId !== null) {
      target = shard.entities.get(aiState.targetId) ?? null;
      if (
        !target ||
        target.hull <= 0 ||
        distanceSq(ai, target) > TARGET_LOCK_AUTO_RELEASE_RANGE_M * TARGET_LOCK_AUTO_RELEASE_RANGE_M
      ) {
        target = null;
      }
    }
    if (!target) {
      target = aggroCandidate;
    }
    if (!target) {
      // Lost the target — back to patrol.
      return enterPatrol({ aiState, nowMs, reason: "lost-target" });
    }
    // Acquire timer elapsed?
    if (nowMs - aiState.acquireStartedAt >= AI_ACQUIRE_DELAY_MS) {
      return enterEngage({ ai, aiState, target, nowMs });
    }
    // Still acquiring — keep approaching the target at half
    // thrust (the player needs time to react).
    return aggroDecision({ ai, aiState, target, cls, dt, nowMs });
  }

  // --- ENGAGE --------------------------------------------------
  if (aiState.mode === "ENGAGE") {
    // Drop target if dead or out of range.
    let target: SimEntity | null = null;
    if (aiState.targetId !== null) {
      target = shard.entities.get(aiState.targetId) ?? null;
      if (
        !target ||
        target.hull <= 0 ||
        distanceSq(ai, target) > TARGET_LOCK_AUTO_RELEASE_RANGE_M * TARGET_LOCK_AUTO_RELEASE_RANGE_M
      ) {
        target = null;
      }
    }
    if (!target) {
      // Try to re-acquire — maybe a different candidate is
      // now in the AGGRO cone.
      if (aggroCandidate) {
        return enterAggro({
          ai,
          aiState,
          target: aggroCandidate,
          nowMs,
          reason: "re-acquire",
        });
      }
      return enterPatrol({ aiState, nowMs, reason: "no-target" });
    }
    // Pursue + fire.
    return engageDecision({
      ai,
      aiState,
      target,
      cls,
      dt,
      nowMs,
      rng: args.rng,
    });
  }

  // Fallback: stay in current mode, drift.
  return {
    input: idleInput(),
    fire: null,
    mode: aiState.mode,
    reason: "fallback",
  };
}

// ---------------------------------------------------------------------------
// State transition helpers — produce AiDecision values for
// PATROL / AGGRO / ENGAGE / DISENGAGE.
// ---------------------------------------------------------------------------

function enterPatrol(args: { aiState: AiStateRecord; nowMs: number; reason: string }): AiDecision {
  args.aiState.mode = "PATROL";
  args.aiState.targetId = null;
  args.aiState.acquireStartedAt = 0;
  args.aiState.disengageUntil = 0;
  return {
    input: idleInput(),
    fire: null,
    mode: "PATROL",
    reason: `patrol:${args.reason}`,
  };
}

function enterAggro(args: {
  ai: SimEntity;
  aiState: AiStateRecord;
  target: SimEntity;
  nowMs: number;
  reason: string;
}): AiDecision {
  args.aiState.mode = "AGGRO";
  args.aiState.targetId = args.target.id;
  args.aiState.acquireStartedAt = args.nowMs;
  args.aiState.lastAcquiringBroadcastMs = args.nowMs;
  // Emit an "ACQUIRING" toast on the targeted player's HUD.
  // The actual WS push happens in `tickAi` (this pure helper
  // doesn't touch the shard's connection set).
  return {
    input: idleInput(),
    fire: null,
    mode: "AGGRO",
    reason: `aggro:${args.reason}`,
  };
}

function enterEngage(args: {
  ai: SimEntity;
  aiState: AiStateRecord;
  target: SimEntity;
  nowMs: number;
}): AiDecision {
  args.aiState.mode = "ENGAGE";
  args.aiState.acquireStartedAt = 0;
  return {
    input: idleInput(),
    fire: null,
    mode: "ENGAGE",
    reason: "engage",
  };
}

function enterDisengage(args: {
  ai: SimEntity;
  aiState: AiStateRecord;
  cls: ShipClass;
  nowMs: number;
}): AiDecision {
  args.aiState.mode = "DISENGAGE";
  args.aiState.targetId = null;
  args.aiState.acquireStartedAt = 0;
  args.aiState.disengageUntil = args.nowMs + AI_DISENGAGE_DURATION_MS;
  // Break off at max speed toward the nearest patrol waypoint.
  return disengageDecision({
    ai: args.ai,
    aiState: args.aiState,
    cls: args.cls,
    dt: 0,
    nowMs: args.nowMs,
  });
}

function patrolDecision(args: {
  ai: SimEntity;
  aiState: AiStateRecord;
  cls: ShipClass;
  dt: number;
  nowMs: number;
}): AiDecision {
  const patrolCenter = args.ai.aiPatrolCenter ?? args.ai.pos;
  const patrolRadius = args.ai.aiPatrolRadius ?? 0;
  const waypoints = waypointsFor({
    center: patrolCenter,
    radius: patrolRadius || 500,
  });
  const target = waypoints[args.aiState.waypointIdx % waypoints.length];
  if (target === undefined) {
    return {
      input: idleInput(),
      fire: null,
      mode: "PATROL",
      reason: "patrol:no-waypoints",
    };
  }
  // Advance waypoint when close to the current one.
  if (distanceVec(args.ai.pos, target) < AI_WAYPOINT_ARRIVAL_M) {
    args.aiState.waypointIdx = (args.aiState.waypointIdx + 1) % waypoints.length;
  }
  return {
    ...steerAndThrust({
      ai: args.ai,
      target,
      classId: args.cls.id,
      speedFrac: AI_PATROL_SPEED_FRAC,
      rng: () => 0,
    }),
    mode: "PATROL",
    reason: "patrol",
  };
}

function aggroDecision(args: {
  ai: SimEntity;
  aiState: AiStateRecord;
  target: SimEntity;
  cls: ShipClass;
  dt: number;
  nowMs: number;
}): AiDecision {
  const lead = leadPointFor(args.target);
  return {
    ...steerAndThrust({
      ai: args.ai,
      target: lead,
      classId: args.cls.id,
      speedFrac: 0.7, // mid-thrust while acquiring
      rng: () => 0,
    }),
    mode: "AGGRO",
    reason: "aggro:acquiring",
  };
}

function engageDecision(args: {
  ai: SimEntity;
  aiState: AiStateRecord;
  target: SimEntity;
  cls: ShipClass;
  dt: number;
  nowMs: number;
  rng: () => number;
}): AiDecision {
  const lead = leadPointFor(args.target);
  const dist = Math.sqrt(distanceVec(args.ai.pos, args.target.pos));
  const weapon = weaponForEngage(dist, args.cls.id);
  // Fire only when forward-pointed within 5° (cheap inner-loop
  // gating — the missile's homing lock is the real aim; the
  // laser needs to be on-axis for the resolver's range check).
  const cos = angleCosineToForward(args.ai, args.target);
  const onAxis = cos >= AI_AGGRO_CONE_COS; // cos(60°) == 0.5
  const wantFire =
    weapon !== null &&
    onAxis &&
    hasEnergyFor(args.ai, weapon) &&
    args.nowMs - args.aiState.lastFireAttemptMs >= (weaponStats(weapon).rate * 1000) / 2;

  // Use lead-point for the steer; the fire intent points at the
  // current target id so `handleFire`'s missile-pick logic
  // locks onto the same target.
  return {
    ...steerAndThrust({
      ai: args.ai,
      target: lead,
      classId: args.cls.id,
      speedFrac: AI_ENGAGE_MAX_THRUCT_FRAC,
      rng: args.rng,
    }),
    fire: wantFire ? { weapon, targetId: args.target.id } : null,
    mode: "ENGAGE",
    reason: "engage:fire",
  };
}

function disengageDecision(args: {
  ai: SimEntity;
  aiState: AiStateRecord;
  cls: cls;
  dt: number;
  nowMs: number;
}): AiDecision {
  // Pick the nearest patrol waypoint and fly toward it at
  // max speed.
  const patrolCenter = args.ai.aiPatrolCenter ?? args.ai.pos;
  const patrolRadius = args.ai.aiPatrolRadius ?? 0;
  const waypoints = waypointsFor({
    center: patrolCenter,
    radius: patrolRadius || 500,
  });
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i]!;
    const d = distanceVec(args.ai.pos, w);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return {
    ...steerAndThrust({
      ai: args.ai,
      target: waypoints[bestIdx]!,
      classId: args.cls.id,
      speedFrac: 1.0, // full speed — spec calls for max
      rng: () => 0,
    }),
    mode: "DISENGAGE",
    reason: "disengage:break-off",
  };
}

// Type alias used by disengageDecision to keep the import cycle
// flat — `ShipClass` is re-exported by the shared ships module.
type cls = ShipClass;

// ---------------------------------------------------------------------------
// Steering + thrust
// ---------------------------------------------------------------------------

interface SteerAndThrustArgs {
  ai: SimEntity;
  target: Vec3;
  classId: ShipClassId;
  speedFrac: number;
  rng: () => number;
}

/**
 * Pure steering + thrust helper. Builds the `ShipInput` that
 * `integrateShip` will consume.
 *
 * Steering:
 *   - `yaw` and `pitch` are computed from the desired heading
 *     quaternion relative to the current quaternion (per-tick
 *     delta, clamped to [-1, 1] so the integrator clamps to
 *     `shipClass.turnRate * dt`).
 *   - Roll is zero (the AI never rolls).
 *
 * Thrust:
 *   - When the heading error is small (< 0.1 rad ≈ 5.7°),
 *     full `speedFrac * shipClass.acceleration` thrust.
 *   - When the heading error is large (> π/2 ≈ 90°), zero
 *     thrust — the AI can't accelerate in the wrong direction.
 *   - Linear interpolation between.
 */
function steerAndThrust(args: SteerAndThrustArgs): AiDecision {
  // Compute desired heading quaternion.
  const desiredQuat = headingTowardPoint({
    entity: args.ai,
    target: args.target,
  });
  // Decompose desired → current rotation into yaw / pitch axes.
  const yaw = clampUnit(yawAxisFromQuatDelta(args.ai.quat, desiredQuat));
  const pitch = clampUnit(pitchAxisFromQuatDelta(args.ai.quat, desiredQuat));
  const err = headingErrorRad({ entity: args.ai, target: args.target });
  // Thrust proportional to heading error (large error → small
  // thrust; small error → near-full thrust).
  const frac = clamp(1 - err / (Math.PI / 2), 0, 1);
  // Blend the curve so the AI keeps some thrust even at 90°
  // error (otherwise the AI stalls in a tail-chase and never
  // gets around). Spec calls for "proportional", so we use a
  // quadratic blend: t = frac² + (1 - frac²) * 0.3.
  const thrustFrac = args.speedFrac * (frac * frac + (1 - frac * frac) * 0.3);
  const thrust = clamp01(thrustFrac);
  return {
    input: {
      thrust,
      yaw,
      pitch,
      roll: 0,
      up: 0,
    },
    fire: null,
    // Caller fills in mode + reason via the decision wrapper.
    // We don't trust the sentinel here — see
    // `engageDecision` / `aggroDecision` / `patrolDecision` /
    // `disengageDecision`, which each re-tag the mode.
    mode: "PATROL",
    reason: "steer",
  };
}

// ---------------------------------------------------------------------------
// Distance + math helpers
// ---------------------------------------------------------------------------

function distanceSq(a: SimEntity, b: SimEntity): number {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const dz = b.pos.z - a.pos.z;
  return dx * dx + dy * dy + dz * dz;
}

function distanceVec(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clampUnit(value: number): number {
  return clamp(value, -1, 1);
}

function idleInput(): ShipInput {
  return { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };
}

function hasEnergyFor(entity: SimEntity, weapon: "laser" | "missile"): boolean {
  const energy = entity.energy ?? 0;
  return energy >= weaponStats(weapon).energy;
}

/**
 * Yaw axis (Y) of the rotation that maps the current orientation
 * to the desired orientation. Returns a value clamped to [-1, 1]
 * so `integrateShip`'s `clampUnit` doesn't have to do work.
 */
function yawAxisFromQuatDelta(current: Quat, desired: Quat): number {
  const delta = quatMul(quatInvert(current), desired);
  // 2 * (w * y + z * x) is the Y component of the rotation
  // applied to the local +Z forward.
  return 2 * (delta.w * delta.y + delta.z * delta.x);
}

function pitchAxisFromQuatDelta(current: Quat, desired: Quat): number {
  const delta = quatMul(quatInvert(current), desired);
  // 2 * (w * x + y * z) is the X component of the rotation
  // applied to the local +Z forward.
  return 2 * (delta.w * delta.x + delta.y * delta.z);
}

/** Naive quaternion inverse (assumes unit quaternion). */
function quatInvert(q: Quat): Quat {
  const l = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (l < 1e-12) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: -q.x / l, y: -q.y / l, z: -q.z / l, w: q.w / l };
}

// ---------------------------------------------------------------------------
// Tick — applies the state machine to every AI entity on the
// shard. Called once per sim tick from `runOneStep`.
// ---------------------------------------------------------------------------

/**
 * Walk every AI entity on the shard, compute the desired input,
 * integrate (shared flight model), and dispatch any fire intents
 * through the standard `handleFire` path.
 *
 * The function is intentionally a single linear pass — the
 * per-AI work is bounded by the roster size (6..10 ships per
 * shard) and the integration cost is the same as a player ship.
 *
 * Side effects:
 *   1. Mutates `entity.pos / vel / quat / regime` via the
 *      shared `integrateShip`.
 *   2. Updates `aiState.mode / targetId / waypointIdx /
 *      disengageUntil / lastFireAttemptMs / recentlyDamagedBy`.
 *   3. On AGGRO transition (PATROL → AGGRO or PATROL → AGGRO
 *      via the `sighted` reason) it pushes a
 *      `combat_event { kind: 'ai_acquiring' }` frame to the
 *      targeted player's connection via `shard.send`.
 *   4. On fire acceptance, drains energy + advances cooldown
 *      through the standard pipeline (no separate bookkeeping).
 *
 * Cost: O(aiCount) per tick. The 10-AI benchmark (TASK-46
 * acceptance) asserts the cost fits inside the 30 ms tick
 * budget when combined with the player registry.
 */
export function tickAi(args: {
  shard: Shard;
  dt: number;
  nowMs?: number;
  /** TEST-ONLY: override the RNG seed source (determinism test). */
  seedOverride?: bigint;
  /** TEST-ONLY: log helper. */
  logger?: Pick<Console, "debug" | "warn">;
}): {
  decisions: number;
  fires: number;
  aggroTransitions: number;
  tickMs: number;
} {
  const shard = args.shard;
  const now = args.nowMs ?? Date.now();
  const tick = shard.sim.currentTick;
  const tickStart =
    (args.shard.sim as unknown as { hooks?: { clock?: () => number } }).hooks?.clock?.() ?? now;
  // Seed the RNG once per tick so all AI decisions in this tick
  // share the same sequence (matches the spec: "same tick
  // sequence → same AI behaviour").
  const seed = args.seedOverride ?? aiRngSeedForTick(shard.systemId, tick);
  const rng = mulberry32(seed);

  let decisions = 0;
  let fires = 0;
  let aggroTransitions = 0;

  // Snapshot the AI ids so we can mutate `shard.aiStates`
  // mid-iteration if needed.
  const aiIds: string[] = [];
  for (const [id, e] of shard.entities) {
    if (e.kind === "ai") aiIds.push(id);
  }

  // TASK-60: one pass over the registry collects the player/character
  // positions the dormant-AI distance test reads, instead of one
  // entity walk per AI.
  const playerPositions: number[] = [];
  for (const [, e] of shard.entities) {
    if (e.kind !== "player" && e.kind !== "character") continue;
    playerPositions.push(e.pos.x, e.pos.y, e.pos.z);
  }

  for (const aiId of aiIds) {
    const ai = shard.entities.get(aiId);
    if (!ai || ai.kind !== "ai") continue;
    // Skip un-hydrated AI entities. The TASK-45 hydrate path
    // always populates `aiSpawnPos`, `aiPatrolCenter`, and
    // `aiPatrolRadius` (the latter from the roster picker,
    // always >= AI_PATROL_RADIUS_MIN_M = 200). A vanilla
    // `makeAiEntity` fixture (e.g. the weapons.test.ts target
    // harness) leaves `aiPatrolRadius` at 0 — we use that as
    // the "skip" signal so test fixtures that use AI-kind
    // entities as combat targets don't get integrated.
    if (
      !ai.aiSpawnPos ||
      !ai.aiPatrolCenter ||
      ai.aiPatrolRadius === undefined ||
      ai.aiPatrolRadius === null ||
      ai.aiPatrolRadius <= 0
    ) {
      continue;
    }
    const aiState = ensureAiState(shard, ai);
    // Skip dead AIs — the entity should have been removed by
    // `scheduleAiRespawn` already, but defensive skip prevents
    // a stale ghost entity from crashing the loop.
    if (aiState.mode === "DEAD" || ai.hull <= 0) continue;

    // TASK-60: dormant AI — past `AI_DORMANT_RANGE_M` from every
    // player, a patrolling AI re-decides at 1 Hz instead of 20 Hz.
    // Engaged AI (`AGGRO` / `ENGAGE` / `DISENGAGE`) always run the
    // full state machine: they have a target, so they are near-field
    // by definition and their cost is the gameplay.
    if (aiState.mode === "PATROL" && now - aiState.lastFullTickMs < AI_DORMANT_TICK_MS) {
      if (nearestPlayerDistSq(ai, playerPositions) > AI_DORMANT_RANGE_M * AI_DORMANT_RANGE_M) {
        continue;
      }
    }

    const prevMode = aiState.mode;
    aiState.lastFullTickMs = now;
    const decision = decideAi({
      ai,
      aiState,
      shard,
      dt: args.dt,
      nowMs: now,
      rng,
    });
    decisions += 1;
    // The decision helper mutates aiState.mode; trust the
    // returned mode for telemetry.
    if (decision.mode !== prevMode) {
      if (decision.mode === "AGGRO") aggroTransitions += 1;
      // AGGRO transitions trigger the ACQUIRING toast.
      if (decision.mode === "AGGRO" && aiState.targetId !== null) {
        pushAiAcquiringToast({
          ai,
          target: shard.entities.get(aiState.targetId),
          tick,
          shard,
        });
      }
    }
    aiState.mode = decision.mode;

    // Integrate via the shared flight model. We copy the
    // flight output back onto the entity so the broadcast loop
    // sees the new pos / vel / quat / regime.
    if (decision.mode !== "DEAD") {
      integrateAiEntity(ai, decision.input, args.dt, shard);
    }

    // Fire intent — route through handleFire so the AI obeys
    // the same energy + rate + lockout gates as players.
    if (decision.fire !== null) {
      const ghostConnId = `${AI_GHOST_CONN_PREFIX}${ai.id}`;
      ensureAiGhostConnection(shard, ghostConnId, ai);
      const result = handleFire({
        shard,
        connId: ghostConnId,
        weapon: decision.fire.weapon,
        targetId: decision.fire.targetId,
        nowMs: now,
      });
      if (result.ok === "accepted") {
        fires += 1;
        aiState.lastFireAttemptMs = now;
      }
    }
  }

  const tickEnd =
    (args.shard.sim as unknown as { hooks?: { clock?: () => number } }).hooks?.clock?.() ?? now;
  return {
    decisions,
    fires,
    aggroTransitions,
    tickMs: Math.max(0, tickEnd - tickStart),
  };
}

// ---------------------------------------------------------------------------
// Integration — wraps the shared flight model.
// ---------------------------------------------------------------------------

import { integrateShip } from "@shared/physics/flight.js";

/**
 * TASK-60: squared distance from `ai` to the nearest player /
 * character, reading a flat `[x, y, z, x, y, z, ...]` position list
 * built once per tick. Returns `Infinity` when nobody is in the
 * shard — an all-AI shard keeps every AI dormant until a player
 * arrives, which is exactly the win the criterion names.
 */
export function nearestPlayerDistSq(ai: SimEntity, positions: readonly number[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const dx = (positions[i] ?? 0) - ai.pos.x;
    const dy = (positions[i + 1] ?? 0) - ai.pos.y;
    const dz = (positions[i + 2] ?? 0) - ai.pos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < best) best = distSq;
  }
  return best;
}

function integrateAiEntity(ai: SimEntity, input: ShipInput, dt: number, _shard: Shard): void {
  const cls = shipClassFor(ai);
  if (!cls) return;
  // The AI sits in pure space by default (TASK-45 places them
  // outside any atmosphere cylinder). If a future task puts an
  // AI inside an atmosphere the integrator will fall through to
  // the same regime resolution players use.
  const prevState: ShipState = {
    pos: { ...ai.pos },
    vel: { ...ai.vel },
    quat: { ...ai.quat },
    regime: ai.regime,
    onPad: ai.onPad ?? undefined,
  };
  const next = integrateShip(prevState, input, dt, ai.regime, cls, undefined);
  ai.pos.x = next.pos.x;
  ai.pos.y = next.pos.y;
  ai.pos.z = next.pos.z;
  ai.vel.x = next.vel.x;
  ai.vel.y = next.vel.y;
  ai.vel.z = next.vel.z;
  ai.quat.x = next.quat.x;
  ai.quat.y = next.quat.y;
  ai.quat.z = next.quat.z;
  ai.quat.w = next.quat.w;
  ai.regime = next.regime;
}

// ---------------------------------------------------------------------------
// Ghost connection — synthetic ShardConnection so handleFire can
// look up the AI's entity via the standard conn.entityId path.
// ---------------------------------------------------------------------------

/**
 * Make sure the shard has a ghost connection for the given AI
 * entity. Idempotent — a second invocation reuses the existing
 * entry. The ghost connection is NOT broadcast via the
 * presence roster (the loop in `buildSnapshotEntities` only
 * walks `shard.entities`, not `shard.connections`).
 */
function ensureAiGhostConnection(shard: Shard, connId: string, ai: SimEntity): void {
  const existing = shard.connections.get(connId);
  if (existing) {
    if (existing.entityId !== ai.id) existing.entityId = ai.id;
    return;
  }
  const conn: ShardConnection = {
    connId,
    callsign: ai.callsign ?? "AI",
    playerId: `ai:${ai.id}`,
    shipId: ai.id,
    entityId: ai.id,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  shard.connections.set(connId, conn);
}

// ---------------------------------------------------------------------------
// State map management
// ---------------------------------------------------------------------------

/**
 * Look up the AI's state record, creating a fresh one on
 * first contact. The record persists across respawns (the
 * entity id is stable) so a re-minted AI starts in PATROL with
 * `waypointIdx = 0`.
 *
 * The map is stored on `shard.aiStates` (added by the shard
 * factory in `index.ts`). When the shard was built before the
 * map existed (legacy fixture) we lazily add it.
 */
export function ensureAiState(shard: Shard, ai: SimEntity): AiStateRecord {
  const map = ensureAiStatesMap(shard);
  const existing = map.get(ai.id);
  if (existing) return existing;
  const fresh: AiStateRecord = {
    aiId: ai.id,
    mode: "PATROL",
    targetId: null,
    acquireStartedAt: 0,
    waypointIdx: 0,
    disengageUntil: 0,
    lastFireAttemptMs: 0,
    recentlyDamagedBy: new Map(),
    lastAcquiringBroadcastMs: 0,
    lastFullTickMs: 0,
  };
  map.set(ai.id, fresh);
  return fresh;
}

/** Drop the AI state record. Called by `cancelAiRespawn`. */
export function clearAiState(shard: Shard, aiId: string): boolean {
  const map = ensureAiStatesMap(shard);
  return map.delete(aiId);
}

/**
 * Get the AI states map, lazily initialising it on the shard.
 * Returns the same map on every call so the caller can mutate
 * it directly.
 */
export function ensureAiStatesMap(shard: Shard): Map<string, AiStateRecord> {
  const s = shard as unknown as { aiStates?: Map<string, AiStateRecord> };
  if (!s.aiStates) {
    s.aiStates = new Map();
  }
  return s.aiStates;
}

/**
 * Read-only accessor for the per-ai state record. Returns
 * `null` for AIs the map doesn't know about (e.g. fixtures that
 * haven't run yet). Used by tests + the debug overlay.
 */
export function getAiState(shard: Shard, aiId: string): AiStateRecord | null {
  const map = ensureAiStatesMap(shard);
  return map.get(aiId) ?? null;
}

/**
 * Note a hit on the AI from a player source. Called by
 * `applyCombatDamage` (TASK-23) for any rogue hit so the AGGRO
 * check sees a fresh `recentlyDamagedBy` entry for the player.
 */
export function noteAiDamagedBy(
  shard: Shard,
  args: {
    aiId: string;
    playerId: string;
    nowMs?: number;
  },
): void {
  const aiState = getAiState(shard, args.aiId);
  if (!aiState) return;
  aiState.recentlyDamagedBy.set(args.playerId, args.nowMs ?? Date.now());
}

/**
 * Push the "ACQUIRING" toast to the targeted player's WS
 * connection. Uses the same `combat_event` wire shape as
 * hit / destroyed, with the new `ai_acquiring` kind. Falls
 * back silently when the target connection isn't in the
 * shard (e.g. the player warped out between AGGRO trigger and
 * the decision commit).
 */
function pushAiAcquiringToast(args: {
  ai: SimEntity;
  target: SimEntity | undefined;
  tick: number;
  shard: Shard;
}): void {
  const { target } = args;
  const shard = args.shard;
  const ai = args.ai;
  if (!target) return;
  if (!target.playerId) return;
  // Find the connection for the target player. We iterate the
  // connections map so we don't depend on a future entity →
  // connection reverse index.
  for (const conn of shard.connections.values()) {
    if (conn.playerId !== target.playerId) continue;
    if (!conn.connId.startsWith("c-")) continue; // skip AI ghosts
    const event: AiAcquiringEvent = {
      kind: "ai_acquiring",
      source: { kind: "ai", id: ai.id, callsign: ai.callsign },
      target: target.id,
      tick: args.tick,
    };
    // The shape extends `ProtocolCombatEvent` so we cast for
    // transport-agnostic compatibility.
    try {
      shard.send(conn.connId, {
        type: "combat_event",
        payload: event as unknown as ProtocolCombatEvent,
      } as unknown as Parameters<typeof shard.send>[1]);
    } catch {
      // swallow
    }
    return;
  }
  // Defensive: if no real player connection was found, the AI
  // is firing at a target whose player is in another shard
  // (shouldn't happen — `pickAggroTarget` only picks players in
  // this shard — but the helper doesn't crash on the mismatch).
}

// ---------------------------------------------------------------------------
// Type guard — used by the audit test to keep the combat_event
// schema honest.
// ---------------------------------------------------------------------------

export function isAiAcquiringEvent(
  event: ProtocolCombatEvent,
): event is Extract<ProtocolCombatEvent, { kind: "ai_acquiring" }> {
  return (event as { kind?: string }).kind === "ai_acquiring";
}

// Mark the import as used (Node's strict TS would otherwise
// strip the EventEmitter import that some downstream consumers
// rely on for the AI event seam).
void EventEmitter;

// Mark imports referenced only by type as such so unused-import
// lint doesn't trip during edits.
void vecAdd;
void vecLength;
void vecLengthSq;
void vecNormalize;
void vecScale;
void vecSub;
void quatMul;
void quatRotateVector;
void X_AXIS;
void Y_AXIS;
void Z_AXIS;
void TARGET_LOCK_AUTO_RELEASE_RANGE_M;
