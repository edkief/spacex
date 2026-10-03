/**
 * Client dock-panel state (TASK-40) — the single source of truth for the
 * 'dock' UI (opened by the server's 'ui-open' {ui:'dock'} frame from the
 * station-terminal interaction). The panel's Sell tab is driven by:
 * - the 'ui-open' frame's payload (the initial hold + inventory — the panel
 *   opens fully populated), and
 * - every 'sell' result frame (the NEW hold + inventory + balance — the
 *   source stack decreases and the counter updates within one frame).
 *
 * Follows the subscribe/emit idiom of state/cargo.ts: set → emit only on
 * change (stable JSON); late subscribers catch up. The balance is seeded
 * from the credits store at open time and overwritten by each sell result.
 */

import { canonicalJson } from '@shared/canonical';
import { credits } from './credits';

/** The wire shape of the dock panel's hold (mirrors the 'cargo'/'sell' frames). */
export interface DockHoldView {
  stacks: Record<string, number>;
  weightUsed: number;
  capacity: number;
}

/** The wire shape of the dock panel's on-foot inventory. */
export interface DockInventoryView {
  stacks: Record<string, number>;
  weightUsed: number;
}

/** The dock panel's state (closed = nothing rendered). */
export interface DockPanelState {
  open: boolean;
  terminalId: string | null;
  hold: DockHoldView | null;
  inventory: DockInventoryView | null;
  /** The credit balance (seeded from the credits store; set by sell results). */
  balance: number | null;
}

type DockListener = (state: DockPanelState) => void;

const CLOSED: DockPanelState = {
  open: false,
  terminalId: null,
  hold: null,
  inventory: null,
  balance: null,
};

const listeners = new Set<DockListener>();
let current: DockPanelState = CLOSED;
let currentJson = canonicalJson(CLOSED);

function emit(next: DockPanelState): void {
  const json = canonicalJson(next);
  if (json === currentJson) return;
  current = next;
  currentJson = json;
  for (const fn of [...listeners]) fn(next);
}

/** Open (or re-fill) the panel from a 'ui-open' {ui:'dock'} payload. */
export function openDockPanel(
  terminalId: string | null,
  hold: DockHoldView | null,
  inventory: DockInventoryView | null,
): void {
  emit({ open: true, terminalId, hold, inventory, balance: credits() });
}

/**
 * Apply a 'sell' result frame — replace the stacks with the NEW ones the
 * frame carries and set the balance (the source stack visibly decreases and
 * the counter updates within one frame). The panel was open when the sell
 * was requested, so `open`/`terminalId` are preserved.
 */
export function applySellResult(
  balance: number,
  hold: DockHoldView,
  inventory: DockInventoryView,
): void {
  if (!current.open) return; // a stale sell frame never opens the panel
  emit({ open: true, terminalId: current.terminalId, hold, inventory, balance });
}

/** Close the panel (Esc / the close button). */
export function closeDockPanel(): void {
  emit(CLOSED);
}

/** The current panel state. */
export function dockPanel(): DockPanelState {
  return current;
}

/** Subscribe to panel-state changes. Calls fn(currentState) immediately; returns the unsubscribe. */
export function dockPanelSubscribe(fn: DockListener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: reset (mirrors __resetCargoPanel). */
export function __resetDockPanel(): void {
  listeners.clear();
  current = CLOSED;
  currentJson = canonicalJson(CLOSED);
}
