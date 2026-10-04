/**
 * Client menu-shell state (TASK-53) — the ONE open-surface stack: the ESC
 * menu, the star chart, and the shared ship/dock panel (one panel at a
 * time). ESC opens the menu when nothing is open and otherwise POPS the
 * top surface (panel → menu → closed); the world keeps simulating the
 * whole time (multiplayer — the server is unaware, by design).
 *
 * The stack is the input-gating source of truth: the flight/on-foot loops
 * and every game-key handler read `anySurfaceOpen()` to drop non-ESC input
 * (the menu is modal except for ESC, the AC's contract).
 *
 * Follows the subscribe/emit idiom of state/cargo.ts: set → emit only on
 * change (stable JSON); late subscribers catch up.
 */

import { canonicalJson } from '@shared/canonical';

/** A panel surface's rendered root element id (the DOM contract). */
export type PanelSurfaceId = 'cargo-panel' | 'dock-panel' | 'ship-panel';

/** The panel context — drives the available tab set (one component, TASK-53). */
export type PanelContext = 'docked' | 'flight' | 'dock';

/** The tabs of the shared ship/dock panel. */
export type PanelTab = 'overview' | 'cargo' | 'repair' | 'sell';

/** One open panel: which root element + context + initially-active tab. */
export interface PanelSurface {
  kind: 'panel';
  id: PanelSurfaceId;
  title: string;
  context: PanelContext;
  activeTab: PanelTab;
}

/** The surfaces that can sit on the stack. */
export type Surface = { kind: 'menu' } | { kind: 'chart' } | PanelSurface;

type MenuListener = (stack: readonly Surface[]) => void;

let current: Surface[] = [];
let currentJson = canonicalJson(current);
const listeners = new Set<MenuListener>();

function emit(next: Surface[]): void {
  const json = canonicalJson(next);
  if (json === currentJson) return;
  current = next;
  currentJson = json;
  for (const fn of [...listeners]) fn(current);
}

/** The current stack (bottom → top). */
export function menuStack(): readonly Surface[] {
  return current;
}

/** The topmost surface (null when nothing is open). */
export function topSurface(): Surface | null {
  return current[current.length - 1] ?? null;
}

/** True while ANY surface is open (the game-input suppression gate). */
export function anySurfaceOpen(): boolean {
  return current.length > 0;
}

/** Open the ESC menu — only from the empty stack (ESC from an open surface pops instead). */
export function openMenu(): boolean {
  if (current.length > 0) return false;
  emit([...current, { kind: 'menu' }]);
  return true;
}

/**
 * Open the star chart (the M key, the HUD Systems button, or the menu's
 * Systems item — all the same call). The chart never stacks on a panel
 * (one modal level at a time) and never duplicates.
 */
export function openChart(): boolean {
  if (current.some((s) => s.kind === 'chart' || s.kind === 'panel')) return false;
  emit([...current, { kind: 'chart' }]);
  return true;
}

/** Open the shared panel — one panel per stack, whichever context opened it. */
export function openPanel(surface: Omit<PanelSurface, 'kind'>): boolean {
  if (current.some((s) => s.kind === 'panel')) return false;
  emit([...current, { ...surface, kind: 'panel' }]);
  return true;
}

/** Pop the top surface (ESC); null when the stack is empty. */
export function popSurface(): Surface | null {
  if (current.length === 0) return null;
  const popped = current[current.length - 1];
  emit(current.slice(0, -1));
  return popped;
}

/** Close everything (a system swap never carries an open surface). */
export function closeAllSurfaces(): void {
  if (current.length === 0) return;
  emit([]);
}

/** Subscribe to stack changes. Calls fn(currentStack) immediately; returns the unsubscribe. */
export function menuSubscribe(fn: MenuListener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: reset the stack + subscribers. */
export function __resetMenu(): void {
  listeners.clear();
  current = [];
  currentJson = canonicalJson(current);
}
