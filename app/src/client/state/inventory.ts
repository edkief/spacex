/**
 * Client inventory state (TASK-34) — the weight bar's single source of
 * truth: the player's OWN inventory as sent by the server on the player's
 * own entity (10 Hz entity_update — the HUD updates within one snapshot of
 * any change).
 *
 * Follows the subscribe/emit idiom of src/client/state/docked.ts: set →
 * emit only on change (stable JSON comparison); late subscribers get the
 * current value. HUD only — never feeds prediction or the input loop.
 */

import { canonicalJson } from '@shared/canonical';

/** The wire shape of a player inventory (EntityState.inventory). */
export interface InventoryView {
  stacks: Record<string, number>;
  weightUsed: number;
}

type InventoryListener = (value: InventoryView | null) => void;

const listeners = new Set<InventoryListener>();
let current: InventoryView | null = null;
let currentJson = '';

/** Set the inventory; emitted only on a real change (stable-JSON compare). */
export function setInventory(value: InventoryView | null): void {
  const json = value ? canonicalJson(value) : '';
  if (json === currentJson) return;
  current = value;
  currentJson = json;
  for (const fn of [...listeners]) fn(value);
}

/** The current inventory (null until the first self entity carries one). */
export function inventory(): InventoryView | null {
  return current;
}

/** Subscribe to inventory changes. Calls fn(currentValue) immediately; returns the unsubscribe. */
export function inventorySubscribe(fn: InventoryListener): () => void {
  listeners.add(fn);
  fn(current); // late subscribers catch up
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: clear subscribers + reset (mirrors __resetDockedIndicator). */
export function __resetInventory(): void {
  listeners.clear();
  current = null;
  currentJson = '';
}
