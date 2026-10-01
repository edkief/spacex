/**
 * Docked-indicator state (TASK-29.3) — one boolean for the whole client:
 * whether the #docked-indicator HUD stub is shown.
 *
 * Driven by the live session's self entity_update handler (10 Hz): true
 * EXACTLY while the wire regime is 'docked' AND a padId is set (isDocked —
 * the pure predicate). The full ship HUD is TASK-51; this stub never feeds
 * physics. Follows the subscribe/emit idiom of src/client/state/reentry.ts:
 * set → emit only on change; late subscribers get the current value.
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

/** Test helper: clear subscribers + reset to hidden (mirrors __resetReentryTint). */
export function __resetDockedIndicator(): void {
  listeners.clear();
  current = false;
}
