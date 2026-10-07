/**
 * Cruise state store (TASK-85) — the per-frame HUD fact for the space
 * cruise boost: is the boost demand HELD (Shift in the space scheme) and
 * is it ALLOWED at the predicted position (shared `cruiseAllowedAt`)?
 *
 * Written by the ship prediction loop (render rate) from the CURRENT input
 * + predicted position; the HUD tag (CRUISE / CRUISE BLOCKED) subscribes.
 * Emit-on-change: a key frame only re-notifies on held/allowed changes, so
 * the 60 fps loop costs the HUD nothing while the values stay stable.
 */

/** The HUD-visible cruise state. */
export interface CruiseState {
  /** Boost demand held (Shift pressed in the space scheme). */
  held: boolean;
  /** `cruiseAllowedAt(predicted pos)` — cruise can engage here. */
  allowed: boolean;
}

const INITIAL: CruiseState = { held: false, allowed: true };
let state: CruiseState = INITIAL;
const listeners = new Set<(s: CruiseState) => void>();

/** Publish the cruise state (emit-on-change). */
export function setCruiseState(next: CruiseState): void {
  if (next.held === state.held && next.allowed === state.allowed) return;
  state = next;
  for (const l of listeners) l(next);
}

/** The current cruise state. */
export function cruiseState(): CruiseState {
  return state;
}

/** Subscribe; the listener fires immediately with the current state. */
export function cruiseStateSubscribe(listener: (s: CruiseState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function __resetCruiseState(): void {
  state = INITIAL;
  listeners.clear();
}
