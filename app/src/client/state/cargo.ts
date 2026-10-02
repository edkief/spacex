/**
 * Client cargo-panel state (TASK-39) — the single source of truth for the
 * 'cargo' UI: the ship's hold (always) + the on-foot inventory (only while
 * standing at the docked ship — in flight the panel is the hold only).
 *
 * Driven exclusively by the server's per-connection 'cargo' frame (the
 * panel is a per-player view; the shared 10 Hz snapshot buffer never
 * carries it). Follows the subscribe/emit idiom of src/client/state/
 * inventory.ts: set → emit only on change (stable JSON comparison); late
 * subscribers catch up. HUD only.
 */

import { canonicalJson } from '@shared/canonical';

/** The wire shape of the 'cargo' frame's hold. */
export interface CargoHoldView {
  stacks: Record<string, number>;
  weightUsed: number;
  capacity: number;
}

/** The wire shape of the 'cargo' frame's inventory (omitted in flight). */
export interface CargoInventoryView {
  stacks: Record<string, number>;
  weightUsed: number;
}

/** The cargo panel's state (closed = nothing rendered). */
export interface CargoPanelState {
  open: boolean;
  hold: CargoHoldView | null;
  inventory: CargoInventoryView | null;
}

type CargoListener = (state: CargoPanelState) => void;

const CLOSED: CargoPanelState = { open: false, hold: null, inventory: null };

const listeners = new Set<CargoListener>();
let current: CargoPanelState = CLOSED;
let currentJson = canonicalJson(CLOSED);

function emit(next: CargoPanelState): void {
  const json = canonicalJson(next);
  if (json === currentJson) return;
  current = next;
  currentJson = json;
  for (const fn of [...listeners]) fn(next);
}

/** Open (or re-fill) the panel with a 'cargo' frame's contents. */
export function openCargoPanel(hold: CargoHoldView, inventory: CargoInventoryView | null): void {
  emit({ open: true, hold, inventory });
}

/** Close the panel (Esc / the close button). */
export function closeCargoPanel(): void {
  emit(CLOSED);
}

/** The current panel state. */
export function cargoPanel(): CargoPanelState {
  return current;
}

/**
 * Subscribe to panel-state changes. Calls fn(currentState) immediately;
 * returns the unsubscribe.
 */
export function cargoPanelSubscribe(fn: CargoListener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: reset (mirrors __resetInventory). */
export function __resetCargoPanel(): void {
  listeners.clear();
  current = CLOSED;
  currentJson = canonicalJson(CLOSED);
}
