/**
 * Pure ship damage math — TASK-23.
 *
 * Server-authoritative damage pipeline foundation. `applyDamage`
 * operates on a *copy* of the entity state the sim owns; it returns
 * the new HP values plus a small descriptor (`{shieldHit, hullHit,
 * destroyed}`) that downstream code (the sim tick, the WS broadcast,
 * the HUD) uses to react.
 *
 * Ordering contract (acceptance criterion):
 *
 *   1. Shields absorb **first**.
 *   2. Overflow damage (amount > shields) chips the hull.
 *   3. Hull below zero → the entity is **destroyed**.
 *
 * Boundary cases (covered by the unit tests):
 *
 *   - `amount == 0`               — no-op; nothing hit, not destroyed.
 *   - `amount > 0 && amount <= S` — shields absorb all, hull unchanged.
 *   - `amount == S`               — exact boundary: shields go to zero,
 *                                   hull untouched.
 *   - `amount == S + 1`           — one HP overflows to hull.
 *   - `amount == S + H`           — exact hull kill: shields zero,
 *                                   hull zero, destroyed.
 *   - `amount > S + H`            — overkill: same as exact kill, the
 *                                   extra damage is dropped.
 *   - Already destroyed           — double-destroy guard returns
 *                                   `{shieldHit: 0, hullHit: 0,
 *                                    destroyed: true}` without
 *                                   mutating the (already zero) HP.
 *
 * Source attribution:
 *
 *   - `source.kind` is one of `"player" | "ai"`. The id is the
 *     callsign (player) or the AI roster id (NPC). The shape is
 *     intentionally small so it can be embedded verbatim in the
 *     `combat_event` wire payload (TASK-23 AC #2).
 *
 * Design choices:
 *
 *   - **Pure function** — no `Math.random`, no `Date.now`, no
 *     mutation of the input. Same inputs → same outputs.
 *   - **Clamps HP to `[0, max]`** — a hostile client can't drive
 *     shields negative by sending an absurd damage number; we
 *     clamp on the way in.
 *   - **No side effects on destroyed entities** — the caller is
 *     expected to swap the entity for a wreck + broadcast the
 *     `destroyed` combat event. `applyDamage` just reports.
 *
 * @see ../../../server/shard/combat.ts for the sim-side integration
 *      (entity mutation, combat_event broadcast, wreck spawning).
 * @see ../../protocol/schemas.ts for the wire shape.
 */

import { shipStats, type ShipClass, type ShipClassId } from "../ships.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Attribution for the source of a damage event. Used by the HUD to
 * render the "hit by …" toast and by analytics to bucket damage
 * by attacker type (player killshot vs NPC killshot). Mirrors the
 * wire contract on `combat_event` (TASK-23 AC #2).
 */
export interface DamageSource {
  /** Discriminating source kind. */
  kind: "player" | "ai" | "drone";
  /** Stable identifier (callsign for players, roster id for AI,
   * drone id for drones — see TASK-48). */
  id: string;
}

/**
 * Mutable HP slice of an entity — the only fields `applyDamage`
 * touches. Everything else (position, velocity, livery, etc.) is
 * orthogonal.
 */
export interface DamageTarget {
  /** Current shield HP. Clamped to `[0, maxShields]` on output. */
  shields: number;
  /** Current hull HP. Clamped to `[0, maxHull]` on output. */
  hull: number;
}

/**
 * Outcome of a damage application. `shieldHit` + `hullHit` sum to
 * the portion of `amount` that was *actually absorbed* — overflow
 * above `S + H` is dropped silently (no `overDamage` field, callers
 * don't need it).
 *
 * `destroyed: true` means hull went to zero on this call **OR** the
 * target was already at zero hull on entry. The double-destroy case
 * lets the broadcast loop emit a `destroyed` event exactly once per
 * death without a separate "is this a fresh death" check at the
 * caller — callers should still de-duplicate by entity id because
 * the function itself has no memory of prior calls.
 */
export interface ApplyDamageResult {
  /** Damage absorbed by shields this call. */
  shieldHit: number;
  /** Damage absorbed by hull this call (overflow past shields). */
  hullHit: number;
  /** Whether the target is now at hull == 0 (just-destroyed OR pre-destroyed). */
  destroyed: boolean;
  /** New shield HP after the hit. Always in `[0, maxShields]`. */
  newShields: number;
  /** New hull HP after the hit. Always in `[0, maxHull]`. */
  newHull: number;
}

/**
 * Inputs to `applyDamage`. The function is intentionally narrow so
 * the caller doesn't have to assemble a full `SimEntity` to test
 * it — pass any object with `{ hull, shields }` and the class
 * maxes.
 *
 * `source` is opaque to `applyDamage` itself (it doesn't validate
 * the id beyond passing it back through `applyDamage`); the shape
 * matches the wire format so the caller can forward `source`
 * verbatim into the `combat_event` broadcast payload.
 */
export interface ApplyDamageInput {
  /** Current HP slice. */
  target: DamageTarget;
  /** Class id — used to look up `maxHull` and `maxShields`. */
  classId: ShipClassId;
  /** Positive finite damage amount. Non-positive is a no-op. */
  amount: number;
  /** Attribution. Embedded verbatim into the wire `combat_event`. */
  source: DamageSource;
}

// ---------------------------------------------------------------------------
// applyDamage
// ---------------------------------------------------------------------------

/**
 * Apply `amount` damage to `target`. Pure: no mutation of inputs.
 *
 * The shields-absorb-first ordering is enforced regardless of how
 * the caller framed the math. Overkill (amount > S + H) is dropped
 * silently — the entity is destroyed either way, and the broadcast
 * carries `{shieldHit, hullHit}` so the HUD can animate the final blow
 * without needing the overkill amount.
 *
 * Already-destroyed inputs return `{destroyed: true}` without
 * emitting additional `hullHit`. This makes the function safe to
 * call repeatedly without compounding damage in the broadcast.
 *
 * Examples (using scout: hull=100, shields=50):
 *
 *   applyDamage({target:{hull:100,shields:50}, classId:'scout', amount:30, source:{kind:'player',id:'X'}})
 *     → {shieldHit:30, hullHit:0, destroyed:false, newShields:20, newHull:100}
 *
 *   applyDamage({target:{hull:100,shields:50}, classId:'scout', amount:50, source:{kind:'player',id:'X'}})
 *     → {shieldHit:50, hullHit:0, destroyed:false, newShields:0, newHull:100}
 *   — exact shield boundary; hull is untouched.
 *
 *   applyDamage({target:{hull:100,shields:50}, classId:'scout', amount:51, source:{kind:'player',id:'X'}})
 *     → {shieldHit:50, hullHit:1, destroyed:false, newShields:0, newHull:99}
 *   — one HP overflows past shields into hull.
 *
 *   applyDamage({target:{hull:100,shields:50}, classId:'scout', amount:150, source:{kind:'player',id:'X'}})
 *     → {shieldHit:50, hullHit:100, destroyed:true, newShields:0, newHull:0}
 *   — exact kill: S+H absorbed; entity is destroyed.
 *
 *   applyDamage({target:{hull:100,shields:50}, classId:'scout', amount:200, source:{kind:'player',id:'X'}})
 *     → {shieldHit:50, hullHit:100, destroyed:true, newShields:0, newHull:0}
 *   — overkill: same result; the extra 50 is dropped.
 */
export function applyDamage(input: ApplyDamageInput): ApplyDamageResult {
  const klass = classMaxes(input.classId);
  const maxShields = klass.shieldCapacity;
  const maxHull = klass.hull;

  // Clamp the *current* HP read to the class max in case the entity
  // was over-healed (e.g. by a future buff). Avoids negative or
  // super-cap starting points corrupting the math.
  const shields = clamp(input.target.shields, 0, maxShields);
  const hull = clamp(input.target.hull, 0, maxHull);

  // Non-positive damage → no-op. Caller probably has a NaN, a
  // mis-bucketed "armor-pierce" path, or a zero-damage event (e.g.
  // a missile that splashed without exploding). We still report
  // `destroyed` if the entity was already at hull zero so the
  // caller can de-dupe without a separate branch.
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return {
      shieldHit: 0,
      hullHit: 0,
      destroyed: hull <= 0,
      newShields: shields,
      newHull: hull,
    };
  }

  // Already-destroyed fast path: don't mutate HP, don't re-emit
  // `hullHit`. Callers use the result to de-dupe `destroyed` events.
  if (hull <= 0) {
    return {
      shieldHit: 0,
      hullHit: 0,
      destroyed: true,
      newShields: shields,
      newHull: 0,
    };
  }

  // 1. Shields absorb first. `shieldHit` is the amount actually
  //    applied (clamped to whatever's left in the shield pool).
  const shieldHit = Math.min(shields, input.amount);
  const shieldsAfter = shields - shieldHit;

  // 2. Overflow past shields hits the hull.
  const overflow = input.amount - shieldHit;
  const hullHit = Math.min(hull, overflow);
  const hullAfter = hull - hullHit;

  return {
    shieldHit,
    hullHit,
    destroyed: hullAfter <= 0,
    newShields: shieldsAfter,
    newHull: hullAfter,
  };
}

// ---------------------------------------------------------------------------
// Repair cost
// ---------------------------------------------------------------------------

/**
 * Compute the credit cost to fully repair a docked ship.
 *
 * Formula (acceptance criterion):
 *
 *   cost = ceil((1 - hull / maxHull) * 10) + ceil((1 - shields / maxShields) * 5)
 *
 * Two terms (hull, shield) so the per-system cost is visible to
 * the dock UI. Both terms clamp to >= 0 — a player who somehow has
 * `hull > maxHull` (e.g. a future buff) still gets a non-negative
 * bill.
 *
 * The result is always an integer (ceil of a finite float); the
 * caller is expected to pass it straight to `withdrawCredits`.
 *
 * Examples (scout: hull=100, shields=50):
 *
 *   repairCost({hull:100, shields:50}, 'scout')     // full health
 *     → 0
 *
 *   repairCost({hull:0,   shields:0  }, 'scout')    // fully wrecked
 *     → ceil(10) + ceil(5) = 15
 *
 *   repairCost({hull:50,  shields:50 }, 'scout')    // 50% hull, full shields
 *     → ceil(5) + 0 = 5
 */
export function repairCost(current: DamageTarget, classId: ShipClassId): number {
  const klass = classMaxes(classId);
  const maxHull = klass.hull;
  const maxShields = klass.shieldCapacity;

  const hullTerm = Math.ceil(Math.max(0, (1 - current.hull / maxHull) * 10));
  const shieldTerm = Math.ceil(Math.max(0, (1 - current.shields / maxShields) * 5));
  return hullTerm + shieldTerm;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the class maxes via the shared catalog. Throws via
 * `shipStats` if the id is unknown (impossible at runtime — the
 * wire schema only accepts the three known ids — but the throw
 * surfaces schema regressions early).
 */
function classMaxes(classId: ShipClassId): ShipClass {
  return shipStats(classId);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
