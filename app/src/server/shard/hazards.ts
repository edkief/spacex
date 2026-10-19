/**
 * Surface hazards — authoritative simulation — TASK-48.
 *
 * Owns the per-shard hazard lifecycle:
 *
 *   - `advanceHazards(shard, args)` — the per-tick entry point.
 *     Walks every connected player's on-foot entity (or docked-ship
 *     position as a proxy when no character exists), checks each
 *     hazard cell, applies damage to the player's exposure pool
 *     (storm = 2 / s, radzone = 5 / s), and pushes a
 *     `hazard_update` frame to the owning connection so the HUD's
 *     radiation meter stays current.
 *   - `applyStormDamage`, `applyRadDamage` — pure per-player
 *     exposure math (regen / decay / recover transition). The tick
 *     orchestrates the call; the math is unit-testable in isolation.
 *   - Drone lifecycle: `tickDrones(shard, dt, nowMs)` walks every
 *     drone entity, decides aggro / attack state, applies damage
 *     to the targeted character (via the exposure pool), and
 *     schedules respawn timers on destruction.
 *   - `scheduleDroneRespawn`, `advanceDroneRespawns` — the
 *     180 s respawn cycle.
 *   - `spawnDrone`, `removeDrone` — entity-factory helpers used
 *     by `hydrateHazards` and the respawn loop.
 *
 * ## Design contract
 *
 *   - **Single writer.** All entity mutations happen on the tick
 *     thread. The drone aggro / attack pipeline mutates
 *     `entity.droneState`, `entity.droneTargetId`, and
 *     `entity.pos` only inside `advanceHazards` so the broadcast
 *     loop reads coherent state on the next snapshot.
 *   - **On-foot targeting.** Drones ignore ships — they look up
 *     the player's character entity (TASK-31) and only aggro
 *     targets that are characters. A ship flying low over a
 *     drone cell is invisible to the drones.
 *   - **Exposure is per-player, not persisted.** Resets on warp /
 *     disembark / shard reap. The PRD calls it a tactical
 *     resource, not inventory.
 *   - **No on-foot death in v1.** Exposure at 0 → recovering for
 *     5 s → respawn into the cell at the same position. The
 *     player never dies; the ship is the stakes (PRD).
 *
 * @see ../../shared/world/hazards.ts for the seed-derived placer
 *      + the spec-pinned constants.
 * @see ./entity.ts for `makeDroneEntity` + the drone wire shape.
 * @see ./combat.ts for the shared damage pipeline; the hazard
 *      pipeline applies drone damage through the same
 *      `combat_event { kind: 'damaged' }` broadcast so the HUD's
 *      combat log unifies drone hits with player / AI hits.
 */
import {
  DRONE_AGGRO_RADIUS_M,
  DRONE_ATTACK_CADENCE_MS,
  DRONE_ATTACK_DAMAGE,
  DRONE_ATTACK_RADIUS_M,
  DRONE_HULL,
  DRONE_RESPAWN_DELAY_MS,
  HAZARD_EXPOSURE_MAX,
  HAZARD_EXPOSURE_REGEN_PER_S,
  HAZARD_RADZONE_DAMAGE_PER_S,
  HAZARD_RECOVER_DURATION_MS,
  HAZARD_STORM_DAMAGE_PER_S,
  type HazardCell,
} from "@shared/world/hazards.js";

import { broadcastCombatEvent } from "./combat-events.js";
import type {
  Shard,
  ShardDroneRespawn,
  ShardHazardCell,
  ShardPlayerHazardState,
  SimEntity,
} from "./types.js";

// ---------------------------------------------------------------------------
// Player hazard math (pure — easy to unit-test)
// ---------------------------------------------------------------------------

/**
 * Step a single player's exposure pool forward by `dt` seconds.
 *
 * - When `inHazard === true`: subtract `damagePerSecond * dt`,
 *   clamp at 0. If the floor is hit, transition to recovering for
 *   `HAZARD_RECOVER_DURATION_MS` (the caller passes `nowMs` so the
 *   recover end-time can be computed).
 * - When `inHazard === false`: regenerate at
 *   `HAZARD_EXPOSURE_REGEN_PER_S`, but only when not recovering.
 *   When recovering, the pool stays at 0 — the player can't start
 *   regenerating exposure mid-knockout.
 *
 * Returns the new exposure value + the amount of damage absorbed
 * this step (0 when no damage or when regen was applied). The
 * caller pushes a `hazard_update` frame with these values so the
 * HUD meter ticks smoothly.
 */
export function stepPlayerExposure(args: {
  state: ShardPlayerHazardState;
  damagePerSecond: number;
  dt: number;
  nowMs: number;
}): { newExposure: number; damageThisStep: number } {
  const { state, damagePerSecond, dt, nowMs } = args;
  // Recovering: pool stays at 0 until the timer elapses. Once
  // elapsed the state flips back to idle and regen resumes.
  if (state.recoveringUntilMs > nowMs) {
    state.exposure = 0;
    state.inHazard = false;
    state.lastDamage = 0;
    return { newExposure: 0, damageThisStep: 0 };
  }
  if (state.recoveringUntilMs > 0 && state.recoveringUntilMs <= nowMs) {
    // Recover just ended this tick — leave the pool at 0 so the
    // next tick's regen kicks in cleanly. The HUD gets a
    // `hazard_update` with `recoveringUntilMs: 0` so the prompt
    // clears on the same frame.
    state.recoveringUntilMs = 0;
    state.exposure = 0;
  }
  if (state.inHazard) {
    const dmg = damagePerSecond * dt;
    const next = Math.max(0, state.exposure - dmg);
    const absorbed = state.exposure - next;
    state.exposure = next;
    state.lastDamage = absorbed;
    if (state.exposure <= 0) {
      // Knocked out. The 5 s recover timer starts now.
      state.recoveringUntilMs = nowMs + HAZARD_RECOVER_DURATION_MS;
    }
    return { newExposure: next, damageThisStep: absorbed };
  }
  // Out of hazards: regen at 5 / s, capped at 50.
  const regen = HAZARD_EXPOSURE_REGEN_PER_S * dt;
  const next = Math.min(HAZARD_EXPOSURE_MAX, state.exposure + regen);
  state.exposure = next;
  state.lastDamage = 0;
  return { newExposure: next, damageThisStep: 0 };
}

/**
 * Push a `hazard_update` frame to a single connection. The
 * broadcaster is transport-agnostic — production wires a real
 * WS writer, tests inject a recorder.
 */
export function pushHazardUpdate(
  shard: Shard,
  connId: string,
  payload: {
    exposure: number;
    recoveringUntilMs: number;
    inHazard: boolean;
    recentDamage?: number;
  },
): void {
  shard.send(connId, { type: "hazard_update", payload });
}

/**
 * Get-or-create a player's hazard row. Lazily populated the
 * first time the tick loop touches the player. New rows start at
 * `exposure: HAZARD_EXPOSURE_MAX` so a player who joins the
 * system at full health isn't already half-dead from the storm
 * cell they spawned next to.
 */
export function ensurePlayerHazardState(shard: Shard, connId: string): ShardPlayerHazardState {
  const existing = shard.playerHazards.get(connId);
  if (existing) return existing;
  const created: ShardPlayerHazardState = {
    connId,
    exposure: HAZARD_EXPOSURE_MAX,
    recoveringUntilMs: 0,
    inHazard: false,
    lastDamage: 0,
  };
  shard.playerHazards.set(connId, created);
  return created;
}

/**
 * Drop a player's hazard row. Called when the connection leaves
 * the shard so the map doesn't leak state.
 */
export function clearPlayerHazardState(shard: Shard, connId: string): void {
  shard.playerHazards.delete(connId);
}

/**
 * Resolve the world-space "anchor" a player occupies for hazard
 * detection. The contract: a character entity if the player is
 * on foot, otherwise the docked ship position (so a ship hovering
 * above a storm cell triggers the exposure meter on the captain's
 * behalf — the spec says "hazard damage applies to the nearest
 * owned ship's hull if docked nearby" but the v1 implementation
 * drains the player's exposure pool instead; ship hull is
 * documented as never directly damaged by storms).
 *
 * Returns `null` when neither is set (the player hasn't yet
 * spawned into a ship — the boot sequence).
 */
export function playerHazardAnchor(
  shard: Shard,
  connId: string,
): {
  pos: { x: number; y: number; z: number };
  characterEntity: SimEntity | null;
} | null {
  const conn = shard.connections.get(connId);
  if (!conn) return null;
  const bound = conn.entityId !== null ? shard.entities.get(conn.entityId) : null;
  if (!bound) return null;
  if (bound.kind === "character") {
    return { pos: bound.pos, characterEntity: bound };
  }
  // Ship player: use the ship position as the anchor. Drone aggro
  // ignores ships (see `tickDrones`); the storm / radzone check
  // still drains exposure.
  return { pos: bound.pos, characterEntity: null };
}

// ---------------------------------------------------------------------------
// advanceHazards — the per-tick entry point
// ---------------------------------------------------------------------------

/**
 * Walk every player's hazard row, every hazard cell, and every
 * drone entity. The function is the authoritative per-tick hook
 * the `SimLoop` calls (once per 1/20 s step).
 *
 * Pass an explicit `nowMs` so tests can drive a fake clock; the
 * production call site uses `Date.now()`.
 *
 * Returns per-kind damage totals so the test suite can assert
 * the math without re-deriving it from the entity registry.
 */
export function advanceHazards(
  shard: Shard,
  args: { dt: number; nowMs: number; clock?: () => number },
): HazardTickReport {
  const now = args.nowMs;
  const dt = args.dt;
  let stormDamage = 0;
  let radDamage = 0;

  // 1. Player exposure pass. Walk every connection; for each,
  //    find the cumulative damage from every hazard cell the
  //    anchor is inside.
  for (const connId of shard.connections.keys()) {
    const anchor = playerHazardAnchor(shard, connId);
    if (!anchor) continue;
    const state = ensurePlayerHazardState(shard, connId);
    let totalDamagePerSecond = 0;
    let inHazard = false;
    for (const cell of shard.hazardCells.values()) {
      if (!isInsideCell(anchor.pos, cell)) continue;
      inHazard = true;
      if (cell.kind === "storm") totalDamagePerSecond += HAZARD_STORM_DAMAGE_PER_S;
      else if (cell.kind === "radzone") totalDamagePerSecond += HAZARD_RADZONE_DAMAGE_PER_S;
      // Drone cells don't damage exposure directly (drones attack
      // characters through the damage pipeline, not via the
      // exposure pool — see `tickDrones`).
    }
    state.inHazard = inHazard;
    stepPlayerExposure({
      state,
      damagePerSecond: totalDamagePerSecond,
      dt,
      nowMs: now,
    });
    // Bucket the per-kind damage for the test-suite assertions.
    // Walk the cells again — cheap, bounded by the cells map.
    if (state.inHazard) {
      for (const cell of shard.hazardCells.values()) {
        if (!isInsideCell(anchor.pos, cell)) continue;
        if (cell.kind === "storm") stormDamage += HAZARD_STORM_DAMAGE_PER_S * dt;
        else if (cell.kind === "radzone") radDamage += HAZARD_RADZONE_DAMAGE_PER_S * dt;
      }
    }
    pushHazardUpdate(shard, connId, {
      exposure: state.exposure,
      recoveringUntilMs: state.recoveringUntilMs,
      inHazard: state.inHazard,
      recentDamage: state.lastDamage > 0 ? state.lastDamage : undefined,
    });
    // After pushing, clear the lastDamage so the HUD only sees
    // the damage once per tick.
    state.lastDamage = 0;
  }

  // 2. Drone tick. Patrol / aggro / attack. The drone state
  //    machine is much simpler than the AI state machine
  //    (TASK-46) — drones only have three states and one target
  //    filter (characters only).
  const droneReport = tickDrones(shard, { dt, nowMs: now });
  // Aggregate the drone hits into the report. Used by the test
  // suite for cadence assertions; production reads this from
  // the same report (no separate broadcast fires).
  return {
    stormDamage,
    radDamage,
    droneHits: droneReport.hitsLanded,
    dronesRespawned: advanceDroneRespawns(shard, { nowMs: now }),
  };
}

/** Per-tick hazard report — surfaced for the integration assertion suite. */
export interface HazardTickReport {
  /** Total exposure damage applied this tick from storm cells. */
  stormDamage: number;
  /** Total exposure damage applied this tick from radzone cells. */
  radDamage: number;
  /** Number of drone hits that landed this tick. */
  droneHits: number;
  /** Number of drones respawned this tick. */
  dronesRespawned: number;
}

// ---------------------------------------------------------------------------
// Drone lifecycle
// ---------------------------------------------------------------------------

/**
 * Walk every `kind: 'drone'` entity and advance its state machine
 * by `dt` seconds. The state machine is:
 *
 *   - `patrol` (default): the drone circles its cell centre at
 *     `DRONE_PATROL_RADIUS_M = 30` (a small offset so the
 *     drones don't all sit on top of each other at the cell
 *     centre). The patrol period is 6 s; each drone ticks its
 *     angular position by `(dt / 6) * 2π`.
 *   - `aggro`: an on-foot character is inside the 80 m aggro
 *     radius. The drone steers toward the character at 5 u/s
 *     (cheap linear lerp; the spec doesn't call for a flight
 *     model). The drone returns to `patrol` when the character
 *     exits the aggro radius.
 *   - `attack`: the drone is inside the 30 m attack radius. The
 *     drone applies 3 damage to the character's exposure pool
 *     once every 2 s (`DRONE_ATTACK_CADENCE_MS`). Damage is
 *     delivered through the standard damage pipeline (the same
 *     one weapon hits use); the broadcast is
 *     `combat_event { kind: 'damaged', source: { kind: 'drone' } }`.
 *
 * Drones ignore ships: a player flying low over a drone cell in
 * their ship is invisible to the aggro check. The spec calls out
 * "drones do NOT aggro ships (they ignore space traffic —
 * surface-only threat)".
 */
export function tickDrones(
  shard: Shard,
  args: { dt: number; nowMs: number },
): { hitsLanded: number; aggroCount: number; attackCount: number } {
  let hitsLanded = 0;
  let aggroCount = 0;
  let attackCount = 0;
  for (const entity of shard.entities.values()) {
    if (entity.kind !== "drone") continue;
    if (entity.hull <= 0) continue; // dead drones wait for the respawn timer
    const cell = shard.hazardCells.get(entity.hazardId ?? "");
    if (!cell) continue;
    // Look for the nearest character entity inside the aggro
    // radius. Ships are deliberately skipped.
    const target = nearestCharacterInRange(shard, entity.pos, DRONE_AGGRO_RADIUS_M);
    if (target) {
      entity.droneTargetId = target.id;
      entity.droneState = "aggro";
      aggroCount++;
      const dist = distance(entity.pos, target.pos);
      if (dist <= DRONE_ATTACK_RADIUS_M) {
        entity.droneState = "attack";
        attackCount++;
        // Cadence gate. The drone attacks once every 2 s.
        const ready =
          entity.droneAttackReadyMs === undefined || entity.droneAttackReadyMs <= args.nowMs;
        if (ready) {
          // Apply damage through the standard pipeline. The
          // broadcast is `combat_event { kind: 'damaged' }` with
          // source = drone — the HUD's combat log unifies drone
          // hits with player / AI hits.
          broadcastCombatEvent(shard, {
            kind: "damaged",
            target: target.id,
            source: { kind: "drone", id: entity.id },
            amount: DRONE_ATTACK_DAMAGE,
            shieldHit: 0,
            hullHit: 0,
            tick: shard.sim.currentTick,
          });
          // Drone damage drains the character's owner (player)
          // exposure pool directly. We use the same player hazard
          // row the storm / radzone loop updates so the HUD's
          // radiation meter ticks up from drone hits too.
          const ownerConn = connectionForCharacter(shard, target.id);
          if (ownerConn !== null) {
            const state = ensurePlayerHazardState(shard, ownerConn);
            const dmg = DRONE_ATTACK_DAMAGE;
            const next = Math.max(0, state.exposure - dmg);
            const absorbed = state.exposure - next;
            state.exposure = next;
            state.lastDamage = absorbed;
            if (state.exposure <= 0) {
              state.recoveringUntilMs = args.nowMs + HAZARD_RECOVER_DURATION_MS;
            }
            pushHazardUpdate(shard, ownerConn, {
              exposure: state.exposure,
              recoveringUntilMs: state.recoveringUntilMs,
              inHazard: state.inHazard,
              recentDamage: absorbed > 0 ? absorbed : undefined,
            });
            state.lastDamage = 0;
          }
          entity.droneAttackReadyMs = args.nowMs + DRONE_ATTACK_CADENCE_MS;
          hitsLanded++;
        }
        // Steer toward the target.
        steerDrone(entity, target.pos, args.dt, DRONE_ATTACK_RADIUS_M * 0.6);
      } else {
        // Steer toward the target at chase speed.
        steerDrone(entity, target.pos, args.dt, DRONE_CHASE_SPEED_U_S);
      }
    } else {
      // No target in aggro range: patrol.
      entity.droneTargetId = null;
      entity.droneState = "patrol";
      patrolDrone(entity, cell.pos, args.dt);
    }
  }
  return { hitsLanded, aggroCount, attackCount };
}

/** Drone chase speed (units / s) when closing on a target. */
const DRONE_CHASE_SPEED_U_S = 6;

/** Drone patrol radius — the orbit each drone tracks around the cell centre. */
const DRONE_PATROL_RADIUS_M = 30;

/** Drone patrol period — full revolution takes this many seconds. */
const DRONE_PATROL_PERIOD_S = 6;

/**
 * Step the drone along a patrol orbit around the cell centre.
 * The orbit's angular position is derived from a deterministic
 * per-drone seed so two callers see the same orbits (drones
 * spawn at deterministic angles — see `makeDroneEntity`).
 *
 * `dt` is the per-tick duration in seconds.
 */
function patrolDrone(
  drone: SimEntity,
  cellCentre: { x: number; y: number; z: number },
  dt: number,
): void {
  // Use a derived field on the entity: `droneAngleRad` (added at
  // hydrate time by `makeDroneEntity`). We don't store the
  // angle directly because the entity is the wire shape; the
  // angle lives in a private map on the shard.
  // Simpler: store the angle as a hidden field on the entity
  // (cast through `unknown`) — this keeps the code path tight.
  const angleField = (drone as SimEntity & { _patrolAngleRad?: number })._patrolAngleRad ?? 0;
  const next = angleField + (dt / DRONE_PATROL_PERIOD_S) * Math.PI * 2;
  (drone as SimEntity & { _patrolAngleRad?: number })._patrolAngleRad = next;
  const radius = DRONE_PATROL_RADIUS_M + (drone.droneIndex ?? 0) * 4;
  drone.pos.x = cellCentre.x + Math.cos(next) * radius;
  drone.pos.z = cellCentre.z + Math.sin(next) * radius;
  drone.pos.y = cellCentre.y;
}

/**
 * Linear lerp the drone toward a target position at `speed` u/s.
 * The drone keeps its `y` at the cell centre (no airborne flight).
 */
function steerDrone(
  drone: SimEntity,
  targetPos: { x: number; y: number; z: number },
  dt: number,
  speed: number,
): void {
  const dx = targetPos.x - drone.pos.x;
  const dz = targetPos.z - drone.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= 1e-3) return;
  const step = Math.min(dist, speed * dt);
  drone.pos.x += (dx / dist) * step;
  drone.pos.z += (dz / dist) * step;
}

/**
 * Look up the nearest character entity within `radiusM` of `pos`.
 * Ships and other entity kinds are deliberately skipped.
 */
function nearestCharacterInRange(
  shard: Shard,
  pos: { x: number; y: number; z: number },
  radiusM: number,
): SimEntity | null {
  const radiusSq = radiusM * radiusM;
  let best: SimEntity | null = null;
  let bestDistSq = radiusSq;
  for (const entity of shard.entities.values()) {
    if (entity.kind !== "character") continue;
    const dx = entity.pos.x - pos.x;
    const dy = entity.pos.y - pos.y;
    const dz = entity.pos.z - pos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      best = entity;
    }
  }
  return best;
}

/**
 * Look up the connection id that owns a character entity. Returns
 * `null` when the character isn't bound to any connection (a stale
 * entity after a reconnect, for example — `clearPlayerHazardState`
 * handles the cleanup).
 */
function connectionForCharacter(shard: Shard, characterId: string): string | null {
  // The connection whose `entityId` matches the character id is
  // the owner.
  for (const [connId, conn] of shard.connections) {
    if (conn.entityId === characterId) return connId;
  }
  // Fallback: scan all entities whose id equals the character
  // id and find a player through the connection that owns it.
  // v1 stores `playerId` on the character entity; we can look
  // up the connection by matching `playerId`.
  const character = shard.entities.get(characterId);
  if (!character || character.kind !== "character") return null;
  for (const [connId, conn] of shard.connections) {
    if (conn.playerId === character.playerId) return connId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Drone respawn
// ---------------------------------------------------------------------------

/**
 * Mark a drone as dead (hull = 0) and schedule its respawn.
 * Called by the damage pipeline when a drone takes a killing
 * blow. The actual despawn + respawn happens in
 * `advanceDroneRespawns` on the next tick.
 */
export function killDrone(shard: Shard, args: { droneId: string; nowMs: number }): boolean {
  const drone = shard.entities.get(args.droneId);
  if (!drone || drone.kind !== "drone") return false;
  drone.hull = 0;
  if (!drone.hazardId || drone.droneIndex === undefined) return false;
  shard.droneRespawns.set(args.droneId, {
    droneId: args.droneId,
    hazardId: drone.hazardId,
    droneIndex: drone.droneIndex,
    respawnAtMs: args.nowMs + DRONE_RESPAWN_DELAY_MS,
  });
  // Broadcast a `destroyed` combat event so the HUD can render
  // the drone death (the renderer treats drone kills the same
  // as rogue-AI kills in the kill log).
  broadcastCombatEvent(shard, {
    kind: "destroyed",
    target: drone.id,
    source: { kind: "drone", id: drone.id },
    tick: shard.sim.currentTick,
  });
  return true;
}

/**
 * Walk the per-shard respawn map and re-mint any drone whose
 * `respawnAtMs` has elapsed. Returns the number of drones
 * respawned this call.
 *
 * The dead drone entity is dropped before `spawnDrone` is called
 * — `spawnDrone` is idempotent on entity id (returns the
 * existing entry), and a dead drone at `hull === 0` would
 * short-circuit the spawn and never reset to full health.
 */
export function advanceDroneRespawns(shard: Shard, args: { nowMs: number }): number {
  let count = 0;
  for (const [droneId, respawn] of [...shard.droneRespawns.entries()]) {
    if (respawn.respawnAtMs > args.nowMs) continue;
    const cell = shard.hazardCells.get(respawn.hazardId);
    if (!cell) {
      // Cell vanished (shard reap). Drop the entry without
      // respawning.
      shard.droneRespawns.delete(droneId);
      continue;
    }
    // Drop the dead drone so `spawnDrone` mints a fresh one
    // (otherwise the dead entry would short-circuit on the
    // idempotency check).
    shard.entities.delete(respawn.droneId);
    spawnDrone(shard, {
      id: respawn.droneId,
      hazardId: respawn.hazardId,
      droneIndex: respawn.droneIndex,
      pos: cell.pos,
      nowMs: args.nowMs,
    });
    shard.droneRespawns.delete(droneId);
    count++;
  }
  return count;
}

/**
 * Mint a single drone entity and register it on the shard. Used
 * by `hydrateHazards` (TASK-48 step 2) and the respawn loop.
 *
 * The drone starts at full hull (`DRONE_HULL = 20`), `droneState:
 * 'patrol'`, `droneTargetId: null`, and `droneAttackReadyMs: 0`
 * (ready to fire on first aggro tick).
 */
export function spawnDrone(
  shard: Shard,
  args: {
    id: string;
    hazardId: string;
    droneIndex: number;
    pos: { x: number; y: number; z: number };
    nowMs: number;
  },
): SimEntity {
  const existing = shard.entities.get(args.id);
  if (existing) return existing;
  const entity: SimEntity = {
    id: args.id,
    kind: "drone",
    playerId: null,
    callsign: null,
    // TASK-48: drones carry no ship class; the wire uses
    // `classId: null`. The renderer draws them as small
    // rotating octahedrons regardless of class.
    classId: null,
    hull: DRONE_HULL,
    shields: 0,
    targetId: null,
    pos: { ...args.pos },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: null,
    onPad: null,
    hazardId: args.hazardId,
    droneIndex: args.droneIndex,
    droneState: "patrol",
    droneTargetId: null,
    droneAttackReadyMs: 0,
    // Hidden patrol-angle seed: derived from the drone index so
    // the orbit is deterministic per cell. The runtime ticks it
    // forward inside `patrolDrone`.
    ...({ _patrolAngleRad: (args.droneIndex * Math.PI * 2) / 4 } as object),
  };
  shard.entities.set(args.id, entity);
  void args.nowMs;
  return entity;
}

/**
 * Apply damage to a drone. Damage above `DRONE_HULL` destroys
 * the drone (kills + schedules respawn). Returns `true` when
 * the drone survived.
 */
export function damageDrone(
  shard: Shard,
  args: { droneId: string; amount: number; nowMs: number },
): boolean {
  const drone = shard.entities.get(args.droneId);
  if (!drone || drone.kind !== "drone") return false;
  if (drone.hull <= 0) return false;
  drone.hull = Math.max(0, drone.hull - args.amount);
  if (drone.hull <= 0) {
    killDrone(shard, { droneId: args.droneId, nowMs: args.nowMs });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hazard hydration — populate the shard from the seed-derived list
// ---------------------------------------------------------------------------

/**
 * Walk a `hazardsFor` result and register each cell on the shard.
 * Drone cells additionally mint one `kind: 'drone'` entity per
 * drone in the cell. Idempotent — calling hydrate twice is a no-op.
 */
export function registerHazardCells(
  shard: Shard,
  cells: readonly HazardCell[],
  args: { nowMs: number },
): { cellsRegistered: number; dronesSpawned: number } {
  let cellsRegistered = 0;
  let dronesSpawned = 0;
  for (const cell of cells) {
    if (shard.hazardCells.has(cell.hazardId)) continue;
    const shardCell: ShardHazardCell = {
      hazardId: cell.hazardId,
      planetId: cell.planetId,
      kind: cell.kind,
      pos: { ...cell.pos },
      radius: cell.radius,
      intensity: cell.intensity,
      droneCount: cell.droneCount,
      droneIdPrefix: cell.droneIdPrefix,
    };
    shard.hazardCells.set(cell.hazardId, shardCell);
    cellsRegistered++;
    // Spawn drones. Each drone gets a stable id
    // `drone:<hazardId>:<index>` so respawns re-mint with the
    // same id (clients can keep their HUD consistent).
    for (let i = 0; i < cell.droneCount; i++) {
      const droneId = `${cell.droneIdPrefix}:${i}`;
      spawnDrone(shard, {
        id: droneId,
        hazardId: cell.hazardId,
        droneIndex: i,
        pos: cell.pos,
        nowMs: args.nowMs,
      });
      dronesSpawned++;
    }
  }
  return { cellsRegistered, dronesSpawned };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Squared distance between two world-space points.
 */
function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * True when a world position is inside a hazard cell. Uses the
 * (x, z) plane only — the y-axis is the terrain altitude and
 * the surface layout in v1 is flat (the placer uses `center.y`
 * as the cell's altitude).
 */
function isInsideCell(pos: { x: number; y: number; z: number }, cell: ShardHazardCell): boolean {
  const dx = pos.x - cell.pos.x;
  const dz = pos.z - cell.pos.z;
  return dx * dx + dz * dz <= cell.radius * cell.radius;
}

/** Public list of all hazard cells registered on the shard. */
export function listHazardCells(shard: Shard): readonly ShardHazardCell[] {
  return [...shard.hazardCells.values()];
}

/** Public list of all outstanding drone respawn timers. */
export function listDroneRespawns(shard: Shard): readonly ShardDroneRespawn[] {
  return [...shard.droneRespawns.values()];
}

/**
 * Drop every hazard-related row for a shard. Called by the
 * router's reap path so a reaped shard doesn't leak hazard
 * state into the next lifetime.
 */
export function clearHazardsForShard(shard: Shard): void {
  // Drop drone entities. The shard keeps other entities
  // (ships, deposits, etc.) intact.
  for (const entity of shard.entities.values()) {
    if (entity.kind === "drone") {
      shard.entities.delete(entity.id);
    }
  }
  shard.hazardCells.clear();
  shard.playerHazards.clear();
  shard.droneRespawns.clear();
}
