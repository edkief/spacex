/**
 * Leave-ship (egress) state (TASK-105) — one boolean for the whole client:
 * whether the player's OWN ship can be exited RIGHT NOW off its pad, i.e.
 * the ship is LANDED on the surface (the off-pad half of the egress gate).
 *
 * Driven by the live session's self entity_update handler (10 Hz) from the
 * self SHIP entity: the server flight regime is 'surface' (resting on a
 * landable planet's terrain — the regime machine implies the landable
 * check) AND the total velocity is below the shared egress cap. The cap is
 * the SAME EXIT_SHIP_MAX_SPEED constant the server's gate reads, so the
 * client's prompt and the server's acceptance agree on the threshold. The
 * PAD-docked case is the docked store's job (dockedIndicator — wire regime
 * 'docked' + padId), and a home-dock ship reads as wire regime 'docked'
 * (flight regime 'space'), so it never enters this signal: its egress path
 * is unchanged. The server remains the AUTHORITY: a denied exit_ship answers
 * with the structured 'not-landed' error and the client shows it as today.
 *
 * Follows the subscribe/emit idiom of src/client/state/docked.ts: set →
 * emit only on change; late subscribers get the current value.
 */

import { EXIT_SHIP_MAX_SPEED } from '@shared/interaction';

type CanExitListener = (value: boolean) => void;

/**
 * Pure predicate: the self ship is LANDED and can be exited (the off-pad
 * surface half of the egress gate). The wire flight regime must be
 * 'surface' AND the total speed strictly below the shared cap (a ship at
 * exactly 2 u/s is denied, matching the server's `<` gate).
 */
export function canExitLanded(flightRegime: string, speed: number): boolean {
  return flightRegime === 'surface' && speed < EXIT_SHIP_MAX_SPEED;
}

const listeners = new Set<CanExitListener>();
let current = false;

/** Set the can-exit state; emitted only on change. */
export function setCanExitShip(value: boolean): void {
  if (value === current) return;
  current = value;
  for (const fn of [...listeners]) fn(value);
}

/** The current can-exit state (false when the ship is not a landed surface ship). */
export function canExitShip(): boolean {
  return current;
}

/** Subscribe to can-exit changes. Calls fn(currentValue) immediately; returns the unsubscribe. */
export function canExitShipSubscribe(fn: CanExitListener): () => void {
  listeners.add(fn);
  fn(current); // late subscribers catch up
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: clear subscribers + reset the store to false (mirrors __resetDockedIndicator). */
export function __resetCanExitShip(): void {
  listeners.clear();
  current = false;
}
