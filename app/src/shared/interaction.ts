/**
 * On-foot interaction contract (TASK-33) — the shared constants + pure math
 * behind the interactable raycast (client, per frame) and the range
 * validation (server, per request).
 *
 * v1 interactables are a BOUNDED set (seed deposits ≤ ~200 per system, ships,
 * dock terminals — no spatial hash needed): the raycast runs against a small
 * explicit target list, never the scene graph.
 *
 * Geometry (AC-pinned): max range 3 m (ships: the 5 m enter radius,
 * TASK-35), forward cone 30° (half-angle). BOTH sides anchor the range at
 * the character's position (feet) — the client pre-filter can therefore
 * never present a target the server would reject on range, and the
 * server's check is the authority either way.
 */

import {
  quatRotateVector,
  vecDot,
  vecLength,
  vecNormalize,
  vecSub,
  type Quat,
  type Vec3,
} from './physics/vec';

/** Interaction reach (m): character position ↔ target, 3D distance. */
export const INTERACT_RANGE_M = 3;
/** Forward cone half-angle (deg): the target must face within ±30°. */
export const INTERACT_CONE_DEG = 30;

/**
 * TASK-35: the ENTER-SHIP prompt radius (m). The hull is bigger than a
 * deposit, so re-entry gets the one larger reach — everything else stays
 * at 3 m. One of the two TASK-35 tunables (this + the speed cap below).
 */
export const ENTER_SHIP_RANGE_M = 5;
/**
 * TASK-35: the max ship speed (u/s) that can be (re-)claimed — an IDLE or
 * docked ship (velocity < 1) can be boarded from on foot; a ship moving at
 * 1 u/s or faster cannot ({code:'ship-moving'}).
 */
export const ENTER_SHIP_MAX_SPEED = 1;

/** Entity kinds a player can interact with (the registry's key space). */
export const INTERACTABLE_KINDS = ['deposit', 'ship', 'terminal', 'groundItem'] as const;
export type InteractableKind = (typeof INTERACTABLE_KINDS)[number];

/**
 * The reach for one interactable kind (TASK-35): ships get the 5 m
 * enter radius, everything else the 3 m default. ONE definition so the
 * client raycast and the server validation never drift apart.
 */
export function interactRangeFor(kind: InteractableKind): number {
  return kind === 'ship' ? ENTER_SHIP_RANGE_M : INTERACT_RANGE_M;
}

export function isInteractableKind(kind: string): kind is InteractableKind {
  return (INTERACTABLE_KINDS as readonly string[]).includes(kind);
}

/** One candidate for the raycast (a sparse world object, not a scene node). */
export interface InteractableTarget {
  id: string;
  kind: InteractableKind;
  pos: Vec3;
  /** Callsign (ships) — lets a client pre-filter on ownership. */
  callsign?: string;
  /** TASK-34: ground items — the resource + units ('[E] Take iron x3'). */
  resourceId?: string;
  quantity?: number;
}

/**
 * The character's forward axis in world space (local +Z — the flight model's
 * convention; character quats are yaw-only). Normalized; a zero input quat
 * yields the canonical forward.
 */
export function interactForward(quat: Quat | undefined): Vec3 {
  const f = quatRotateVector(quat ?? { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 1 });
  const n = vecNormalize(f);
  return n.x === 0 && n.y === 0 && n.z === 0 ? { x: 0, y: 0, z: 1 } : n;
}

/** True when the target is within `range` (inclusive) of the character. */
export function inInteractRange(feet: Vec3, pos: Vec3, range: number = INTERACT_RANGE_M): boolean {
  return vecLength(vecSub(pos, feet)) <= range;
}

/**
 * Angle (radians, 0..π/2) between the forward direction and the direction
 * from `origin` to `pos` (a target exactly at the origin faces "everywhere":
 * 0). Pure; the caller passes the unit-ish forward (it is normalized here).
 */
export function interactConeAngle(origin: Vec3, forward: Vec3, pos: Vec3): number {
  const to = vecSub(pos, origin);
  const len = vecLength(to);
  if (len === 0) return 0;
  const cos = Math.min(1, Math.max(-1, vecDot(vecNormalize(forward), to) / len));
  // acos(cos) is already 0..π; the cone test only cares about the acute side
  // (a target behind the character is > 90° and never in the 30° cone).
  return Math.acos(cos);
}

/** True when the target sits within the forward cone (inclusive). */
export function inInteractCone(
  origin: Vec3,
  forward: Vec3,
  pos: Vec3,
  coneDeg: number = INTERACT_CONE_DEG,
): boolean {
  return interactConeAngle(origin, forward, pos) <= (coneDeg * Math.PI) / 180;
}

export interface InteractHit {
  target: InteractableTarget;
  /** Character ↔ target distance (m) — the range anchor. */
  distance: number;
}

/**
 * The per-frame raycast (AC): the NEAREST target within `range` AND the
 * forward cone, or null. Range and cone both anchor at the character's
 * position (the server validates the same reach from the same anchor).
 * An omitted `range` uses the PER-KIND reach (TASK-35: ships get the
 * 5 m enter radius, the rest 3 m); an explicit `range` applies to every
 * target (tests / callers tightening the default).
 * Ties (bit-equal distances) break on the SMALLER id, so the result is
 * independent of the target list's order (determinism, PRD §6).
 */
export function nearestInteractable(
  feet: Vec3,
  forward: Vec3,
  targets: readonly InteractableTarget[],
  range?: number,
  coneDeg: number = INTERACT_CONE_DEG,
): InteractHit | null {
  let best: InteractHit | null = null;
  for (const target of targets) {
    const distance = vecLength(vecSub(target.pos, feet));
    if (distance > (range ?? interactRangeFor(target.kind))) continue;
    if (!inInteractCone(feet, forward, target.pos, coneDeg)) continue;
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && target.id < best.target.id)
    ) {
      best = { target, distance };
    }
  }
  return best;
}
