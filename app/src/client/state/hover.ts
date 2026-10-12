/**
 * Hover state store (TASK-107) — the client-side VTOL hover TOGGLE: one
 * boolean for the whole client. Owner request (M8): VTOL is a toggle — one
 * press of the VTOL control (Space in the atmosphere scheme / the touch
 * VTOL button) enables the deterministic 10 m altitude-hold (the shared
 * 'hover' channel, TASK-106), another press disables it.
 *
 * The state is CLIENT INPUT state (like the pressed keys): the server never
 * stores a 'hover on' flag — the flight loop simply sends the 'hover' tag in
 * every input frame while the toggle is on (the 66 ms cadence of
 * InputFrameSender handles delivery; no cadence change). The two up demands
 * are mutually exclusive (TASK-106 rule): hover on ⇒ 'hover' tag; hover off
 * ⇒ the legacy held-key 'vtol' tag (byte-identical to pre-task behaviour).
 *
 * Auto-disengage: the store is force-offered by the session's self
 * entity_update handler (main.tsx) the moment the wire regime leaves
 * atmosphere/surface — 'space' (the physics branch is unreachable) or
 * egress (a character has no hover) — via {@link hoverAutoDisengage}.
 *
 * Follows the subscribe/emit idiom of src/client/state/docked.ts: set →
 * emit only on change (the HUD re-renders stay cheap); late subscribers get
 * the current value. DOM-free, so the whole store unit-tests under Node.
 */

type HoverListener = (value: boolean) => void;

const listeners = new Set<HoverListener>();
let current = false;

/**
 * Pure predicate: hover is ALLOWED exactly in the atmosphere/surface
 * regimes while IN the ship (the shared physics is a no-op in 'space', and
 * a disembarked character has no hover). Drives the HUD indicator's
 * "allowed" gate (the same gating the CRUISE tag uses for its
 * space-only boost) and the auto-disengage below.
 */
export function hoverAllowed(regime: string, onFoot: boolean): boolean {
  return !onFoot && (regime === 'atmosphere' || regime === 'surface');
}

/** Pure: hover must AUTO-DISENGAGE when it is no longer allowed (space / on foot). */
export function hoverAutoDisengage(regime: string, onFoot: boolean): boolean {
  return !hoverAllowed(regime, onFoot);
}

/** Set the hover state; emitted only on change. */
export function setHoverOn(value: boolean): void {
  if (value === current) return;
  current = value;
  for (const fn of [...listeners]) fn(value);
}

/** Flip the hover state (the one-press toggle both input paths call). */
export function toggleHover(): void {
  setHoverOn(!current);
}

/** The current hover state (false = the legacy held-key VTOL path is live). */
export function hoverOn(): boolean {
  return current;
}

/** Subscribe to hover changes. Calls fn(currentValue) immediately; returns the unsubscribe. */
export function hoverOnSubscribe(fn: HoverListener): () => void {
  listeners.add(fn);
  fn(current); // late subscribers catch up
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: clear subscribers + reset the store to off. */
export function __resetHover(): void {
  listeners.clear();
  current = false;
}
