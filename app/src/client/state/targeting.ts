/**
 * TASK-44: the client targeting state — the target box's data feed and the
 * threat ping. This is STATE ONLY (the TASK-50 combat HUD renders it):
 *
 * - The LOCK is server-owned (the shard's `targets` map); this store keeps
 *   the client's optimistic mirror of it, refreshed from every snapshot and
 *   cleared by an 'invalid-target' error frame.
 * - The target box ({callsign, distance, hull/shield %, bearing}) is
 *   re-derived from each 10 Hz entity_update — the same numbers the server
 *   would compute, no drift.
 * - The THREAT PING: 'hit'/'destroyed' combat_events landing on OUR ship
 *   with a foreign source light a red arc toward the attacker (bearing from
 *   the attacker's snapshot position), fading after 3 s; the arc always
 *   shows the strongest attacker of the last 5 s (shared pickStrongestThreat).
 *
 * Rendered by the TASK-50 combat HUD (src/client/ui/combat-hud/).
 * Follows the subscribe/emit idiom of src/client/state/inventory.ts.
 */

import { canonicalJson } from '@shared/canonical';
import type { EntityState } from '@shared/protocol/schemas';
import type { CombatEvent } from '@client/fx';
import type { Quat, Vec3 } from '@shared/physics/vec';
import {
  forwardOf,
  LOCK_CONE_RAD,
  LOCK_RANGE_M,
  pickNearestInCone,
  pickStrongestThreat,
  relativeBearing,
  THREAT_PING_FADE_MS,
  THREAT_WINDOW_MS,
  type ThreatHit,
} from '@shared/targeting';

/** The live target box (null while nothing is locked / resolved). */
export interface TargetBoxView {
  targetId: string;
  callsign: string;
  /** Straight-line distance (m), updated per snapshot. */
  distance: number;
  hullPct: number;
  shieldPct: number;
  /** Relative bearing (rad, -π..π, positive = right of our nose). */
  bearing: number;
  /** The target's world position (the TASK-50 bracket's projection source). */
  pos: Vec3;
  /** True when the target has locked OUR ship (the wire `targetedBy`). */
  locksUs: boolean;
  /** True for rogue AI ships (the card tags their name with 'AI'). */
  isAi: boolean;
}

/** The threat ping arc (null while nothing is lit). */
export interface ThreatView {
  attackerId: string;
  bearing: number;
  /** Wall-clock ms when the arc is fully faded (3 s per hit). */
  expiresAt: number;
}

export interface TargetingView {
  box: TargetBoxView | null;
  threat: ThreatView | null;
  /** The 'TARGET LOCKED: <callsign>' banner (self-clearing, ~2.5 s). */
  banner: { text: string; atMs: number } | null;
  /** The 'NO TARGET' missile-denial prompt. */
  noTargetAt: number;
}

const BANNER_MS = 2_500;

type Listener = (view: TargetingView) => void;
const listeners = new Set<Listener>();

let locked: { targetId: string; callsign: string } | null = null;
let box: TargetBoxView | null = null;
let threat: ThreatView | null = null;
let banner: { text: string; atMs: number } | null = null;
let noTargetAt = 0;
let hits: ThreatHit[] = [];
let lastEntities: EntityState[] = [];
let selfShipId: string | null = null;
let lastJson = '';

function view(): TargetingView {
  return { box, threat, banner, noTargetAt };
}

function emit(): void {
  const v = view();
  const json = canonicalJson(v);
  if (json === lastJson) return;
  lastJson = json;
  for (const fn of [...listeners]) fn(v);
}

const LOCKABLE = new Set(['ship', 'ai-ship']);

/**
 * Feed every entity_update batch (and system snapshots): refresh the box
 * with LIVE distance/hull/shield/bearing, drop the lock when the target
 * left the snapshot (destroyed / despawned), and refresh the threat arc
 * toward the attacker while they are visible.
 */
export function ingestTargetingEntities(
  entities: readonly EntityState[],
  ownCallsign: string,
  now: number,
  /** The player's id (the wire `targetedBy` carries shooter player ids). */
  ownPlayerId: string | null = null,
): void {
  lastEntities = [...entities];
  const self = lastEntities.find((e) => e.kind === 'ship' && e.callsign === ownCallsign);
  selfShipId = self?.id ?? selfShipId;
  if (locked) {
    const t = lastEntities.find((e) => e.id === locked?.targetId);
    if (!t || t.hull <= 0) {
      locked = null;
      box = null;
    } else if (self) {
      box = {
        targetId: t.id,
        callsign: t.callsign ?? t.id,
        distance: Math.hypot(t.pos.x - self.pos.x, t.pos.y - self.pos.y, t.pos.z - self.pos.z),
        hullPct: Math.round(t.hull * 100),
        shieldPct: Math.round(t.shields * 100),
        bearing: relativeBearing(self.pos, forwardOf(self.rot ?? IDENT_QUAT), t.pos),
        pos: { ...t.pos },
        locksUs:
          ownPlayerId !== null && (t.targetedBy ?? []).includes(ownPlayerId),
        isAi: t.kind === 'ai-ship',
      };
    }
  } else {
    box = null;
  }
  // The arc follows the attacker while they ride the snapshot.
  if (threat && threat.expiresAt > now) {
    const src = lastEntities.find(
      (e) => e.id === threat?.attackerId || e.callsign === threat?.attackerId,
    );
    if (src && self) {
      threat = {
        ...threat,
        bearing: relativeBearing(self.pos, forwardOf(self.rot ?? IDENT_QUAT), src.pos),
      };
    }
  } else if (threat) {
    threat = null;
  }
  if (banner && now - banner.atMs > BANNER_MS) banner = null;
  emit();
}

const IDENT_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * The T-key toggle. Locked → release (caller sends 'target_release').
 * Unlocked → pick the nearest valid ship in the 500 m / 30° cone; when one
 * is found the optimistic lock + 'TARGET LOCKED' banner light immediately
 * and the caller sends 'target_lock' (an 'invalid-target' error frame
 * clears the optimism if the server disagrees).
 */
export function toggleTargetLock(
  now: number,
): { type: 'lock'; targetId: string } | { type: 'release' } | null {
  if (locked) {
    locked = null;
    box = null;
    emit();
    return { type: 'release' };
  }
  const self = lastEntities.find((e) => e.kind === 'ship' && e.id === selfShipId) ?? null;
  if (!self || !self.rot) return null;
  const candidates = lastEntities.filter(
    (e) => LOCKABLE.has(e.kind) && e.id !== self.id && e.hull > 0,
  );
  const pick = pickNearestInCone(
    self.pos,
    forwardOf(self.rot),
    candidates.map((e) => ({ id: e.id, pos: e.pos })),
    LOCK_RANGE_M,
    LOCK_CONE_RAD,
  );
  if (!pick) return null;
  const t = candidates.find((e) => e.id === pick.id)!;
  locked = { targetId: t.id, callsign: t.callsign ?? t.id };
  banner = { text: `TARGET LOCKED: ${locked.callsign}`, atMs: now };
  emit();
  return { type: 'lock', targetId: t.id };
}

/** Clear the optimistic lock when the server rejected it. */
export function onTargetingError(code: string, now: number): void {
  if (code === 'invalid-target' && locked) {
    locked = null;
    box = null;
    emit();
  } else if (code === 'no-target') {
    noTargetAt = now;
    emit();
  }
}

/**
 * Feed every combat_event: a 'hit'/'destroyed' that landed on OUR ship from
 * a foreign source lights the threat arc. Multiple attackers → the
 * strongest of the last 5 s owns the arc (shared selection rule).
 */
export function ingestCombatEvent(
  event: CombatEvent,
  ownPlayerId: string | null,
  now: number,
): void {
  if (event.kind !== 'hit' && event.kind !== 'destroyed') return;
  if (event.target !== selfShipId) return;
  const src = event.source;
  if (!src || (ownPlayerId !== null && src.id === ownPlayerId)) return;
  hits = [
    ...hits.filter((h) => h.atMs >= now - THREAT_WINDOW_MS),
    { sourceId: src.id, damage: event.kind === 'hit' ? event.damage : 0, atMs: now },
  ];
  const best = pickStrongestThreat(hits, now);
  if (!best) return;
  const srcEnt = lastEntities.find((e) => e.id === best || e.callsign === best);
  const self = lastEntities.find((e) => e.kind === 'ship' && e.id === selfShipId);
  const bearing =
    srcEnt && self
      ? relativeBearing(self.pos, forwardOf(self.rot ?? IDENT_QUAT), srcEnt.pos)
      : (threat?.bearing ?? 0);
  threat = { attackerId: best, bearing, expiresAt: now + THREAT_PING_FADE_MS };
  emit();
}

/** Subscribe to targeting-view changes; fn gets the current view at once. */
export function targetingSubscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(view());
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: reset the module store (mirrors __resetInventory). */
export function __resetTargeting(): void {
  listeners.clear();
  locked = null;
  box = null;
  threat = null;
  banner = null;
  noTargetAt = 0;
  hits = [];
  lastEntities = [];
  selfShipId = null;
  lastJson = '';
}
