/**
 * Rogue AI combat state machine (TASK-46) — believable pirates without a
 * behavior tree. One state machine per rogue ship:
 *
 *   PATROL (fly the seeded waypoint loop at 0.5x max speed)
 *     -> AGGRO (a player within AGGRO_RANGE_M and 60deg of forward, or the
 *        player fired on this AI within PLAYER_FIRE_MEMORY_MS)
 *     -> ENGAGE (pursue the LEAD point — target pos + target vel * 0.5 s —
 *        and fire through the SAME server combat pipeline as players)
 *     -> DISENGAGE (hull < DISENGAGE_HULL_FRACTION: break off toward the
 *        nearest patrol waypoint at max speed, re-PATROL after 30 s)
 *     -> DEAD (destroyed — the TASK-45 respawn timer brings it back).
 *
 * The machine is a PURE stepper: `stepAi(state, ship, stats, world)`
 * mutates only the AiState and returns the computed ShipInput (fed to the
 * same integrateShip as players — the AI is just another ship whose inputs
 * come from the machine, not a ws client) + one optional fire intent the
 * shard resolves through the shared handleFire-side pipeline.
 *
 * Determinism (AC): every random decision draws from the SHARD RNG —
 * mulberry32 seeded (systemId ^ tick) — so the same tick sequence on the
 * same system reproduces the same AI behavior bit-for-bit.
 *
 * Fairness (AC): the machine never bypasses the ship's energy / cooldowns
 * / loadout (the shard's `canFire` callback is the same check the player
 * path commits), and rogues NEVER target other rogues — only player ships.
 */

import { hash2, seedFromString } from '@shared/random';
import {
  quatRotateVector,
  vecAdd,
  vecDot,
  vecLength,
  vecScale,
  vecSub,
  type Vec3,
} from '@shared/physics/vec';
import type { ShipClass } from '@shared/ships';
import type { ShipInput, ShipState } from '@shared/physics/flight';
import { WEAPON_BY_ID, type WeaponId } from '@shared/weapons';

/** The AI's modes (the exact set the AC names, DEAD included). */
export type AiMode = 'patrol' | 'aggro' | 'engage' | 'disengage' | 'dead';

/** A player ship within AGGRO_RANGE_M that is INSIDE the forward cone aggros. */
export const AGGRO_RANGE_M = 600;
/** cos(60deg) — the aggro forward cone half-angle (AC: 60 degrees). */
export const AGGRO_CONE_COS = Math.cos(Math.PI / 3);
/** A player firing on the AI aggros it for this long after the shot (AC: 5 s). */
export const PLAYER_FIRE_MEMORY_MS = 5_000;
/** The ACQUIRING delay before the AI may fire (AC: 1 s, the player's chance to react). */
export const ACQUIRE_DELAY_MS = 1_000;
/** Missiles only make sense beyond this range (AC: missiles when target > 300 m). */
export const MISSILE_MIN_RANGE_M = 300;
/** Hull fraction below which the AI breaks off (AC: 25 percent). */
export const DISENGAGE_HULL_FRACTION = 0.25;
/** DISENGAGE lasts this long, then the AI re-PATROLS (AC: 30 s). */
export const DISENGAGE_DURATION_MS = 30_000;
/** Past this distance the target is out-ranged and the AI gives up (back to PATROL). */
export const LOST_TARGET_RANGE_M = 1_200;
/** Patrol speed as a fraction of the class max speed (AC: 0.5x). */
export const PATROL_SPEED_FACTOR = 0.5;
/** Waypoints per patrol loop. */
export const WAYPOINT_COUNT = 4;
/** Closing distance on a patrol waypoint before the next one is picked (u). */
export const WAYPOINT_REACH_M = 50;

/** One AI's mutable machine state (shard-owned, keyed by entity id). */
export interface AiState {
  id: string;
  mode: AiMode;
  targetId: string | null;
  /** Epoch ms the current target acquisition started (the 1 s delay anchor). */
  acquireStartedAtMs: number;
  waypointIdx: number;
  /** The seeded waypoint loop (shard RNG jittered around the roster patrol area). */
  waypoints: Vec3[];
  /** Epoch ms a DISENGAGE ends (then re-PATROL). */
  disengageUntilMs: number;
  /** When/who last fired on this AI (the 5 s aggro memory, AC). */
  lastPlayerFireAtMs: number;
  lastPlayerFireBy: string | null;
  lastModeChangeAtMs: number;
}

/** Minimal view of one targetable player ship (rogues never target rogues). */
export interface AiPlayerView {
  id: string;
  pos: Vec3;
  vel: Vec3;
}

/** The per-tick world the machine needs (shard-supplied; no module state). */
export interface AiWorld {
  tick: number;
  nowMs: number;
  dt: number;
  /** The AI's current normalized hull (0..1 — the disengage threshold input). */
  hull: number;
  /** Every LIVE player ship (destroyed / disembarked ships are excluded). */
  players: AiPlayerView[];
  /** The SAME loadout + cooldown + energy check the player fire path commits. */
  canFire(weapon: WeaponId): boolean;
}

/** The machine's per-tick output: the computed inputs + one fire intent. */
export interface AiStepResult {
  input: ShipInput;
  fire?: { weapon: WeaponId; targetId: string };
  /** Set when this tick the AI BEGAN acquiring this player (the ACQUIRING toast). */
  acquiring?: string;
}

export const ZERO_SHIP_INPUT: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };

/**
 * mulberry32 — a tiny, fast, pure 32-bit PRNG (the AC names it for the
 * shard RNG; same seed + same call sequence = identical values everywhere).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The shard RNG for one tick: mulberry32 over (systemId ^ tick). Seeding
 * per tick (instead of a long-lived stream) keeps AI decisions immune to
 * draw-order drift: two shards in lockstep always draw the same values.
 */
export function tickRng(systemId: string, tick: number): () => number {
  return mulberry32(Number(hash2(seedFromString(systemId), BigInt(tick)) & 0xffffffffn));
}

/**
 * The seeded patrol loop for one rogue: `count` points around the roster's
 * patrol center at a jittered radius (0.75..1.25 x patrolRadius, seeded
 * angles) — all in the y=0 plane (rogues are space-only, TASK-45).
 */
export function makeWaypoints(rng: () => number, center: Vec3, radius: number, count = WAYPOINT_COUNT): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + rng() * (Math.PI / 2);
    const r = radius * (0.75 + 0.5 * rng());
    pts.push({ x: center.x + Math.cos(angle) * r, y: center.y, z: center.z + Math.sin(angle) * r });
  }
  return pts;
}

/** Fresh machine state for a rogue (PATROL, no target). */
export function createAiState(id: string, nowMs: number, waypoints: Vec3[]): AiState {
  return {
    id,
    mode: 'patrol',
    targetId: null,
    acquireStartedAtMs: 0,
    waypointIdx: 0,
    waypoints,
    disengageUntilMs: 0,
    lastPlayerFireAtMs: 0,
    lastPlayerFireBy: null,
    lastModeChangeAtMs: nowMs,
  };
}

/** Reset a (re)spawned rogue to PATROL with a fresh seeded waypoint loop. */
export function resetAiState(state: AiState, rng: () => number, center: Vec3, radius: number, nowMs: number): void {
  state.mode = 'patrol';
  state.targetId = null;
  state.acquireStartedAtMs = 0;
  state.waypointIdx = 0;
  state.waypoints = makeWaypoints(rng, center, radius);
  state.disengageUntilMs = 0;
  state.lastPlayerFireAtMs = 0;
  state.lastPlayerFireBy = null;
  state.lastModeChangeAtMs = nowMs;
}

function clampUnit(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

/**
 * Steering: turn toward `desired` at the class turn rate (the yaw/pitch
 * demands saturate at +-1, which integrateShip scales by stats.turnRate),
 * with thrust proportional to the speed error (negative = brake) that
 * never thrusters forward while facing away from the target. `desired` is
 * a DIRECTION (need not be normalized).
 */
function steer(ship: ShipState, stats: ShipClass, desired: Vec3, desiredSpeed: number): ShipInput {
  const forward = quatRotateVector(ship.quat, { x: 0, y: 0, z: 1 });
  const right = quatRotateVector(ship.quat, { x: 1, y: 0, z: 0 });
  const up = quatRotateVector(ship.quat, { x: 0, y: 1, z: 0 });
  const len = vecLength(desired);
  const d = len > 1e-6 ? vecScale(desired, 1 / len) : forward;
  const align = Math.max(0, vecDot(forward, d));
  const throttle = clampUnit(((desiredSpeed - vecLength(ship.vel)) / stats.maxVelocity) * 2);
  return {
    thrust: throttle > 0 ? throttle * align : throttle,
    yaw: clampUnit(vecDot(d, right)),
    pitch: clampUnit(-vecDot(d, up)),
    roll: 0,
    up: 0,
  };
}

/** The aggro test: in range + in the 60deg cone, OR the 5 s fire memory. */
function aggroCandidate(state: AiState, ship: ShipState, players: AiPlayerView[], nowMs: number): AiPlayerView | undefined {
  const forward = quatRotateVector(ship.quat, { x: 0, y: 0, z: 1 });
  let best: AiPlayerView | undefined;
  let bestDist = Infinity;
  for (const p of players) {
    const to = vecSub(p.pos, ship.pos);
    const dist = vecLength(to);
    const inCone = dist > 0 && vecDot(to, forward) / dist >= AGGRO_CONE_COS;
    const firedOnMe =
      state.lastPlayerFireBy === p.id && nowMs - state.lastPlayerFireAtMs <= PLAYER_FIRE_MEMORY_MS;
    if (!inCone && !firedOnMe) continue;
    // Nearest candidate wins (ties break by id — deterministic, no rng).
    if (dist < bestDist || (dist === bestDist && (best === undefined || p.id < best.id))) {
      best = p;
      bestDist = dist;
    }
  }
  return best;
}

function toPatrol(state: AiState, nowMs: number): void {
  state.mode = 'patrol';
  state.targetId = null;
  state.acquireStartedAtMs = 0;
  state.lastModeChangeAtMs = nowMs;
}

/** One patrol tick: steer the waypoint loop at 0.5x max speed (AC). */
function patrolStep(state: AiState, ship: ShipState, stats: ShipClass): ShipInput {
  let wp = state.waypoints[state.waypointIdx % state.waypoints.length];
  if (vecLength(vecSub(wp, ship.pos)) <= WAYPOINT_REACH_M) {
    state.waypointIdx = (state.waypointIdx + 1) % state.waypoints.length;
    wp = state.waypoints[state.waypointIdx];
  }
  return steer(ship, stats, vecSub(wp, ship.pos), PATROL_SPEED_FACTOR * stats.maxVelocity);
}

/**
 * One pursue tick: steer toward the LEAD point (target pos + target vel *
 * 0.5 s, AC) at full class speed; fire only after the 1 s acquire delay,
 * and only when the same pipeline check the players get allows it.
 */
function pursueStep(
  state: AiState,
  ship: ShipState,
  stats: ShipClass,
  target: AiPlayerView,
  world: AiWorld,
  mayFire: boolean,
): AiStepResult {
  const lead = vecAdd(target.pos, vecScale(target.vel, 0.5));
  const result: AiStepResult = { input: steer(ship, stats, vecSub(lead, ship.pos), stats.maxVelocity) };
  if (!mayFire || world.nowMs - state.acquireStartedAtMs < ACQUIRE_DELAY_MS) return result;
  const dist = vecLength(vecSub(target.pos, ship.pos));
  const hasMissiles = stats.weaponMounts.missiles > 0;
  const weapon: WeaponId = hasMissiles && dist > MISSILE_MIN_RANGE_M ? 'missile' : 'laser';
  if (dist <= WEAPON_BY_ID[weapon].range && world.canFire(weapon)) {
    result.fire = { weapon, targetId: target.id };
  }
  return result;
}

/**
 * Step the machine for one tick (mutates `state`; pure otherwise). The
 * shard guards the entry conditions (not destroyed, not docked — the guard
 * exists though rogues never dock in v1).
 */
export function stepAi(
  state: AiState,
  ship: ShipState,
  stats: ShipClass,
  world: AiWorld,
): AiStepResult {
  const { nowMs } = world;

  if (state.mode === 'dead') return { input: ZERO_SHIP_INPUT };

  switch (state.mode) {
    case 'patrol': {
      const cand = aggroCandidate(state, ship, world.players, nowMs);
      if (cand) {
        state.mode = 'aggro';
        state.targetId = cand.id;
        state.acquireStartedAtMs = nowMs;
        state.lastModeChangeAtMs = nowMs;
        return { input: pursueStep(state, ship, stats, cand, world, false).input, acquiring: cand.id };
      }
      return { input: patrolStep(state, ship, stats) };
    }
    case 'aggro': {
      const target = state.targetId ? world.players.find((p) => p.id === state.targetId) : undefined;
      if (!target) return { input: (toPatrol(state, nowMs), patrolStep(state, ship, stats)) };
      if (nowMs - state.acquireStartedAtMs >= ACQUIRE_DELAY_MS) {
        state.mode = 'engage';
        state.lastModeChangeAtMs = nowMs;
      }
      // No fire while ACQUIRING (the 1 s delay doubles as the player's grace).
      return pursueStep(state, ship, stats, target, world, false);
    }
    case 'engage': {
      const target = state.targetId ? world.players.find((p) => p.id === state.targetId) : undefined;
      if (!target) return { input: (toPatrol(state, nowMs), patrolStep(state, ship, stats)) };
      if (world.hull < DISENGAGE_HULL_FRACTION) {
        state.mode = 'disengage';
        state.targetId = null;
        state.disengageUntilMs = nowMs + DISENGAGE_DURATION_MS;
        state.lastModeChangeAtMs = nowMs;
        // Break off THIS tick already: nearest patrol waypoint at MAX speed,
        // no fire (AC: hull < 25% → disengage).
        return {
          input: steer(ship, stats, vecSub(nearestWaypoint(state, ship.pos), ship.pos), stats.maxVelocity),
        };
      }
      if (vecLength(vecSub(target.pos, ship.pos)) > LOST_TARGET_RANGE_M) {
        return { input: (toPatrol(state, nowMs), patrolStep(state, ship, stats)) };
      }
      return pursueStep(state, ship, stats, target, world, true);
    }
    case 'disengage': {
      // Break off: nearest patrol waypoint at MAX speed (AC), no fire, until
      // the 30 s elapses and the machine re-PATROLS.
      if (nowMs < state.disengageUntilMs) {
        return {
          input: steer(ship, stats, vecSub(nearestWaypoint(state, ship.pos), ship.pos), stats.maxVelocity),
        };
      }
      toPatrol(state, nowMs);
      return { input: patrolStep(state, ship, stats) };
    }
  }
}

/** The waypoint of the loop closest to the given position. */
function nearestWaypoint(state: AiState, pos: Vec3): Vec3 {
  let best = state.waypoints[0];
  let bestDist = Infinity;
  for (const wp of state.waypoints) {
    const d = vecLength(vecSub(wp, pos));
    if (d < bestDist) {
      bestDist = d;
      best = wp;
    }
  }
  return best;
}
