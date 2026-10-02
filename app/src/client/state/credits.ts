/**
 * Client credits-counter state (TASK-40) — the HUD credit balance: the
 * player's own credits, seeded from GET /api/players/me on session boot and
 * updated in place by every 'sell' result frame (its `balance` field — the
 * counter reflects a completed sale within one frame, the dock panel's
 * "+N cr" float rides the same frame).
 *
 * Follows the subscribe/emit idiom of src/client/state/inventory.ts: set →
 * emit only on change (stable-JSON compare); late subscribers catch up.
 * HUD only.
 */

import { canonicalJson } from '@shared/canonical';

type CreditsListener = (value: number | null) => void;

const listeners = new Set<CreditsListener>();
let current: number | null = null;
let currentJson = '';

/** Set the balance; emitted only on a real change (stable-JSON compare). */
export function setCredits(value: number | null): void {
  const json = value === null ? '' : canonicalJson(value);
  if (json === currentJson) return;
  current = value;
  currentJson = json;
  for (const fn of [...listeners]) fn(value);
}

/** The current balance (null until /api/players/me answers or a sell lands). */
export function credits(): number | null {
  return current;
}

/** Subscribe to balance changes. Calls fn(currentValue) immediately; returns the unsubscribe. */
export function creditsSubscribe(fn: CreditsListener): () => void {
  listeners.add(fn);
  fn(current); // late subscribers catch up
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: clear subscribers + reset. */
export function __resetCredits(): void {
  listeners.clear();
  current = null;
  currentJson = '';
}
