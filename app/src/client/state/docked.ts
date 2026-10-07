/**
 * Docked-indicator state (TASK-29.3) — one boolean for the whole client:
 * whether the #docked-indicator HUD stub is shown.
 *
 * Two sources, driven by the live session's self entity_update handler
 * (10 Hz). The PAD indicator (`isDocked`) is true EXACTLY while the wire
 * regime is 'docked' AND a padId is set — the UI stub. The WIRE docked state
 * (`isWireDocked`) is true whenever the wire regime is 'docked' (a home-dock
 * ship has no padId) — the server-faithful signal the flight loop gates on
 * so it never sends idle frames that would undock a docked ship. The full
 * ship HUD is TASK-51; neither store feeds physics. Follows the
 * subscribe/emit idiom of src/client/state/reentry.ts: set → emit only on
 * change; late subscribers get the current value.
 */

type DockedListener = (value: boolean) => void;

const listeners = new Set<DockedListener>();
let current = false;

/**
 * Pure predicate: the DOCKED indicator is visible only while BOTH the wire
 * regime is 'docked' AND a non-empty padId is set (a 'docked' regime without
 * a pad would be an invalid server state — treat it as not docked).
 */
export function isDocked(regime: string, padId: string | null | undefined): boolean {
  return regime === 'docked' && typeof padId === 'string' && padId.length > 0;
}

/**
 * Pure predicate: the server considers the entity DOCKED — the wire regime
 * alone. A ship docked at the home dock (the starter scout's spawn) has
 * `regime: 'docked'` but NO padId (the home dock is a position, not a pad),
 * so `isDocked` above is false there even though the server freezes the ship
 * and its FIRST input takes it off. This is the broader, server-faithful
 * signal the flight loop gates on to suppress idle frames; the pad-indicator
 * UI keeps the strict `isDocked` predicate (it marks a specific landing pad).
 */
export function isWireDocked(regime: string): boolean {
  return regime === 'docked';
}

/** Set the docked state; emitted only on change. */
export function setDockedIndicator(value: boolean): void {
  if (value === current) return;
  current = value;
  for (const fn of [...listeners]) fn(value);
}

/** The current docked state (false when not docked). */
export function dockedIndicator(): boolean {
  return current;
}

/** Subscribe to docked-state changes. Calls fn(currentValue) immediately; returns the unsubscribe. */
export function dockedIndicatorSubscribe(fn: DockedListener): () => void {
  listeners.add(fn);
  fn(current); // late subscribers catch up
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Second source (TASK-78 close-out): the WIRE docked state — the self
 * entity's regime alone (`isWireDocked`), no padId required. The pad
 * indicator above is a UI element (a specific landing pad); this is the
 * server-faithful "the ship is frozen, first input takes it off" signal the
 * flight loop gates on so it never sends idle frames while the server
 * believes the ship is docked (a home-dock starter has no padId, so the pad
 * predicate is false there). Same subscribe/emit idiom as the pad store.
 */
type WireDockedListener = (value: boolean) => void;
const wireListeners = new Set<WireDockedListener>();
let wireCurrent = false;

/** Set the wire-docked state; emitted only on change. */
export function setWireDocked(value: boolean): void {
  if (value === wireCurrent) return;
  wireCurrent = value;
  for (const fn of [...wireListeners]) fn(value);
}

/** The current wire-docked state (false when the regime is not 'docked'). */
export function wireDockedIndicator(): boolean {
  return wireCurrent;
}

/** Subscribe to wire-docked changes. Calls fn(currentValue) immediately; returns the unsubscribe. */
export function wireDockedSubscribe(fn: WireDockedListener): () => void {
  wireListeners.add(fn);
  fn(wireCurrent);
  return () => {
    wireListeners.delete(fn);
  };
}

/** Test helper: clear subscribers + reset both stores to hidden (mirrors __resetReentryTint). */
export function __resetDockedIndicator(): void {
  listeners.clear();
  current = false;
  wireListeners.clear();
  wireCurrent = false;
}
