/**
 * Boost state store (TASK-108) — the client-side cruise boost TOGGLE: one
 * boolean for the whole client. Owner request (M8): boost is a toggle — one
 * TAP of the boost control (a Shift release within
 * `BOOST_TAP_MAX_MS`, or a tap of the touch BOOST button) engages the
 * space-cruise boost (the shared 'boost' channel, TASK-85), the next tap
 * disengages it. A SHIFT PRESS-HOLD (≥ 200 ms) is never a tap: with the
 * store off it is the legacy held-key demand, byte-identical to pre-task.
 *
 * The state is CLIENT INPUT state (like the pressed keys): the server never
 * stores a 'boost on' flag — the flight loop simply sends the 'boost' tag in
 * every input frame while the toggle is on (the 66 ms cadence of
 * InputFrameSender handles delivery; no cadence change). While the toggle is
 * OFF the payload is byte-identical to pre-task behaviour (Shift held = the
 * legacy held-key boost demand).
 *
 * Auto-disengage: the store is force-offered by the session's self
 * entity_update handler (main.tsx) the moment the wire regime leaves SPACE
 * (atmosphere / surface / egress) — the owner decision: re-entering space
 * starts OFF (the player must re-engage). The server's cruise rule
 * (TASK-85: space only, cruiseAllowedAt clearance) stays the authority —
 * this is UX consistency, not physics.
 *
 * Follows the subscribe/emit idiom of src/client/state/hover.ts: set →
 * emit only on change (the HUD re-renders stay cheap); late subscribers get
 * the current value. DOM-free, so the whole store unit-tests under Node.
 */

type BoostListener = (value: boolean) => void;

const listeners = new Set<BoostListener>();
let current = false;

/**
 * Pure predicate: boost is ALLOWED exactly in the SPACE regime while IN the
 * ship (the shared cruise physics is a no-op outside space —
 * `integrateShip`'s `cruising` flag — and a disembarked character has no
 * boost). Drives the auto-disengage below (the HUD's 'allowed' gate is the
 * separate per-position clearance band, `cruiseAllowedAt`).
 */
export function boostAllowed(regime: string, onFoot: boolean): boolean {
  return !onFoot && regime === 'space';
}

/** Pure: boost must AUTO-DISENGAGE when it is no longer allowed (atmosphere / surface / on foot). */
export function boostAutoDisengage(regime: string, onFoot: boolean): boolean {
  return !boostAllowed(regime, onFoot);
}

/** Set the boost state; emitted only on change. */
export function setBoostOn(value: boolean): void {
  if (value === current) return;
  current = value;
  for (const fn of [...listeners]) fn(value);
}

/** Flip the boost state (the one-press toggle both input paths call). */
export function toggleBoost(): void {
  setBoostOn(!current);
}

/** The current boost state (false = the legacy held-Shift path is live). */
export function boostOn(): boolean {
  return current;
}

/** Subscribe to boost changes. Calls fn(currentValue) immediately; returns the unsubscribe. */
export function boostOnSubscribe(fn: BoostListener): () => void {
  listeners.add(fn);
  fn(current); // late subscribers catch up
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: clear subscribers + reset the store to off. */
export function __resetBoost(): void {
  listeners.clear();
  current = false;
}
