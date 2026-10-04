/**
 * Client 'SHIP LOST' moment state (TASK-49) — the full-screen 2 s moment
 * shown when the player's OWN ship is destroyed. The death is resolved
 * SERVER-side (immediate dock respawn, TASK-49 step 1/2); this store is
 * pure presentation — a 'destroyed' combat_event targeting the self ship
 * arms the moment, the overlay auto-hides after SHIP_LOST_MS.
 *
 * Follows the subscribe/emit idiom of src/client/state/*.ts (emit on
 * change, late subscribers catch up). UI-only, transient.
 */

import { canonicalJson } from '@shared/canonical';

/** The moment lives 2 s (client presentation — the respawn is already done). */
export const SHIP_LOST_MS = 2_000;

/** One 'SHIP LOST' moment. */
export interface ShipLostMoment {
  /** The destroyed ship's owner callsign (self — 'your ship' when unknown). */
  callsign: string;
  /** The killer: callsign when resolvable, raw id for AI / drones. */
  killer: string;
  /** Epoch ms the moment was shown. */
  at: number;
}

type Listener = (moment: ShipLostMoment | null) => void;

const listeners = new Set<Listener>();
let current: ShipLostMoment | null = null;
let currentJson = canonicalJson(current);

function emit(next: ShipLostMoment | null): void {
  const json = canonicalJson(next);
  if (json === currentJson) return;
  current = next;
  currentJson = json;
  for (const fn of [...listeners]) fn(next);
}

/** Show the moment (a 'destroyed' event on the SELF ship). */
export function showShipLost(moment: ShipLostMoment): void {
  emit(moment);
}

/** Hide the moment (the overlay's SHIP_LOST_MS timer). */
export function hideShipLost(): void {
  if (current) emit(null);
}

/** The current moment (null = nothing to render). */
export function shipLostCurrent(): ShipLostMoment | null {
  return current;
}

/** Subscribe to moment changes. Calls fn(current) immediately; returns the unsubscribe. */
export function shipLostSubscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: clear subscribers + state. */
export function __resetShipLost(): void {
  listeners.clear();
  current = null;
  currentJson = canonicalJson(current);
}
