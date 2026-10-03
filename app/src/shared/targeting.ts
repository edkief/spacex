/**
 * TASK-44: targeting math — the shared, PURE core of the lock-on system.
 *
 * The server validates every lock request with these functions (it is the
 * authority on who is locked); the client uses the same numbers for its
 * T-key target SELECTION so the ship the player picked is the ship the
 * server accepts (one definition of "nearest valid target in the cone").
 *
 * v1 scope: ships only (kind 'ship' / 'ai-ship') — deposits, terminals,
 * wrecks and characters are never lockable. Locks are social information:
 * the targeted ship's snapshot carries `targetedBy` so everyone can see
 * who is painting whom (the lock icon, no radar in v1).
 */

import { quatRotateVector, type Quat, type Vec3 } from './physics/vec';

/** Lock-on: a valid target must be within this range (m)… */
export const LOCK_RANGE_M = 500;
/** …and within this half-angle of the ship's forward (30°).
 *  Boundary INCLUSIVE (exactly 500 m / exactly 30° is valid). */
export const LOCK_CONE_RAD = (30 * Math.PI) / 180;
/** Auto-release once the target drifts past this range (m). */
export const LOCK_RELEASE_RANGE_M = 1_500;
/** Auto-release this long after the lock, unless refreshed (ms). */
export const LOCK_TTL_MS = 30_000;
/** Missile fire without a lock: the server picks the nearest ship inside
 *  this nose cone (half-angle rad) and range (m) — the missile's max range. */
export const MISSILE_CONE_RAD = (30 * Math.PI) / 180;
export const MISSILE_CONE_RANGE_M = 800;
/** Threat ping: fades after this long (ms)… */
export const THREAT_PING_FADE_MS = 3_000;
/** …and the indicator is claimed by the strongest source in this window. */
export const THREAT_WINDOW_MS = 5_000;

/** The ship's forward: +Z rotated by its orientation (matches the sim's NOSE). */
export function forwardOf(quat: Quat): Vec3 {
  return quatRotateVector(quat, { x: 0, y: 0, z: 1 });
}

/**
 * True when `targetPos` is a valid lock cone position: distance within
 * (0, rangeM] and the angle between `forward` and the target direction
 * within coneRad. Both boundaries are INCLUSIVE. A target at the exact
 * same position (zero direction) is NOT in the cone (undefined angle).
 */
export function coneContains(
  selfPos: Vec3,
  forward: Vec3,
  targetPos: Vec3,
  rangeM: number,
  coneRad: number,
): boolean {
  const dx = targetPos.x - selfPos.x;
  const dy = targetPos.y - selfPos.y;
  const dz = targetPos.z - selfPos.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d <= 0 || d > rangeM) return false;
  const dotF = (forward.x * dx + forward.y * dy + forward.z * dz) / d;
  const clamped = Math.max(-1, Math.min(1, dotF));
  return Math.acos(clamped) <= coneRad;
}

/** A candidate for lock/missile selection: id + world position. */
export interface TargetCandidate {
  id: string;
  pos: Vec3;
}

/**
 * The nearest candidate inside the cone (the T-key selection AND the
 * server's missile fallback share this). Nearest wins; an exact distance
 * tie resolves to the lexicographically smaller id (deterministic for
 * server and client alike). Undefined when nothing qualifies.
 */
export function pickNearestInCone(
  selfPos: Vec3,
  forward: Vec3,
  candidates: readonly TargetCandidate[],
  rangeM: number,
  coneRad: number,
): TargetCandidate | undefined {
  let best: TargetCandidate | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    if (!coneContains(selfPos, forward, c.pos, rangeM, coneRad)) continue;
    const d = Math.sqrt(
      (c.pos.x - selfPos.x) ** 2 + (c.pos.y - selfPos.y) ** 2 + (c.pos.z - selfPos.z) ** 2,
    );
    if (d < bestD || (d === bestD && best !== undefined && c.id < best.id)) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * The relative bearing (rad, -π..π) from the ship's forward to a world
 * point, measured in the horizontal (XZ) plane — the HUD arc / target-box
 * angle. Positive is to the RIGHT of forward. A vertical forward (or a
 * point directly above/below) degenerates against world +Z, which keeps
 * the value finite everywhere.
 */
export function relativeBearing(selfPos: Vec3, forward: Vec3, point: Vec3): number {
  let fx = forward.x;
  let fz = forward.z;
  const fLen = Math.hypot(fx, fz);
  if (fLen < 1e-9) {
    fx = 0;
    fz = 1; // vertical nose: reference world +Z
  } else {
    fx /= fLen;
    fz /= fLen;
  }
  const tx = point.x - selfPos.x;
  const tz = point.z - selfPos.z;
  return Math.atan2(fz * tx - fx * tz, fx * tx + fz * tz);
}

/** One attacker's contribution to the threat indicator (raw hit damage). */
export interface ThreatHit {
  sourceId: string;
  /** Damage points attributed to the source (destroyed events: 0). */
  damage: number;
  atMs: number;
}

/**
 * The strongest attacker in the recent window: the source with the highest
 * TOTAL damage within [nowMs - windowMs, nowMs]; an exact damage tie goes
 * to the source with the most RECENT hit. Undefined when the window is
 * empty (the indicator shows nothing / has expired).
 */
export function pickStrongestThreat(
  hits: readonly ThreatHit[],
  nowMs: number,
  windowMs: number = THREAT_WINDOW_MS,
): string | undefined {
  const totals = new Map<string, { damage: number; last: number }>();
  for (const h of hits) {
    if (h.atMs < nowMs - windowMs || h.atMs > nowMs) continue;
    const t = totals.get(h.sourceId) ?? { damage: 0, last: -Infinity };
    t.damage += h.damage;
    t.last = Math.max(t.last, h.atMs);
    totals.set(h.sourceId, t);
  }
  let best: string | undefined;
  let bestV = { damage: -1, last: -Infinity };
  for (const [id, t] of totals) {
    if (t.damage > bestV.damage || (t.damage === bestV.damage && t.last > bestV.last)) {
      best = id;
      bestV = t;
    }
  }
  return best;
}
