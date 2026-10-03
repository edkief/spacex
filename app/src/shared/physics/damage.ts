/**
 * Shared ship damage model (TASK-23) — shield-first damage pipeline.
 *
 * Used by the server sim (the authority) when a weapon hit lands — the sim
 * hook is `SystemShard.applyHit`, real weapons wire in TASK-43 — and can be
 * used by the client to pre-render shield flashes from its own predicted
 * hits. The server's result is always authoritative.
 *
 * `applyDamage` is PURE: it operates on the copy of the ship's combat state
 * the caller owns, never mutates its input, and returns the result — the
 * caller applies it to the live entity. Same (ship, amount) is
 * bit-identical across client and server.
 *
 * Units: `amount`, `ship.hull` and `ship.shields` are ABSOLUTE POINTS (the
 * class caps in @shared/ships: scout 100/50, freighter 200/80, interceptor
 * 80/40). Sim entities keep normalized 0..1 fractions on the wire and
 * convert at this boundary.
 */

import { shipStats } from '../ships';

/**
 * Damage attribution for HUD display: who (or what) landed the hit.
 * TASK-48: 'drone' — a hostile surface drone hitting the on-foot player's
 * exposure pool through the same pipeline (the math ignores the source).
 */
export type DamageSource =
  | { kind: 'player'; id: string }
  | { kind: 'ai'; id: string }
  | { kind: 'drone'; id: string };

/**
 * The combat state the damage model needs: remaining hull and shield
 * POINTS. Structurally satisfied by any holder of the two numbers.
 */
export interface DamageShip {
  /** Remaining hull points (0 .. class.hull). */
  hull: number;
  /** Remaining shield points (0 .. class.shieldCapacity). */
  shields: number;
}

/** Result of one hit. Points are ABSOLUTE (see module docs). */
export interface ApplyDamageResult {
  /** Points absorbed by shields (<= shields before the hit). */
  shieldHit: number;
  /** Points that reached the hull (<= hull before the hit). */
  hullHit: number;
  /** True when THIS hit destroyed the ship: remaining hull reached zero. */
  destroyed: boolean;
}

/**
 * Destroyed-boundary epsilon (TASK-42): normalized hull fractions accumulate
 * float error across hits (30/100 of 100 pts can leave 30.000000000000004),
 * so an exactly-lethal hit must still count as the killing one. The model
 * stays PURE and bit-identical across client and server — the epsilon is a
 * constant, not a comparison of two computed values.
 */
const DESTROYED_EPSILON = 1e-9;

function frac01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Apply one hit: shields absorb first, the overflow reaches the hull, and a
 * hull that reaches zero marks the ship destroyed (task: "destroyed state at
 * hull zero"). Overkill is capped at the remaining hull — a 1000-point hit
 * on a 100-point ship reports hullHit 100, not 1000.
 *
 * Guards (both return a no-op `{0, 0, false}`):
 * - `amount <= 0` — zero/negative damage does nothing;
 * - `ship.hull <= 0` — the DOUBLE-DESTROY guard: a dead ship takes no more
 *   damage and never reports `destroyed` again, so the sim cannot re-broadcast
 *   the destroyed event or spawn a second wreck.
 *
 * @param ship   combat state to damage (POINTS; never mutated)
 * @param amount damage in points (weapons from TASK-43 on)
 * @param source attribution carried in the broadcast combat_event (HUD)
 */
export function applyDamage(
  ship: DamageShip,
  amount: number,
  source: DamageSource,
): ApplyDamageResult {
  void source; // contract parameter: the sim broadcasts it; the math ignores it
  if (!(amount > 0) || !(ship.hull > 0)) {
    return { shieldHit: 0, hullHit: 0, destroyed: false };
  }
  const shields = ship.shields > 0 ? ship.shields : 0;
  const hull = ship.hull;
  const shieldHit = Math.min(amount, shields);
  const overflow = amount - shieldHit;
  const hullHit = Math.min(overflow, hull);
  return { shieldHit, hullHit, destroyed: hullHit >= hull - DESTROYED_EPSILON };
}

/**
 * Dock repair price in credits (TASK-23, full restore): 1 credit per 10 % of
 * hull missing plus 1 credit per 20 % of shields missing, each ceilinged and
 * summed. A ship at class caps costs 0; a destroyed ship (0/0) costs 15.
 * The formula is the wire contract — implement it literally (no epsilon),
 * so server, tests and any future client agree bit-for-bit.
 */
export function repairCost(classId: string, hull: number, shields: number): number {
  const cls = shipStats(classId);
  const hullFrac = frac01(cls.hull > 0 ? hull / cls.hull : 0);
  const shieldFrac = frac01(cls.shieldCapacity > 0 ? shields / cls.shieldCapacity : 0);
  return Math.ceil((1 - hullFrac) * 10) + Math.ceil((1 - shieldFrac) * 5);
}
