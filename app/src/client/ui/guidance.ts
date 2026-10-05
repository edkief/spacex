/**
 * TASK-56: first-launch guidance — the state machine + its store.
 *
 * The hint line is SERVER-INDEPENDENT: the client detects the events
 * (docked, disembark, first pickup, first sale) from the live stores and
 * advances the machine. The furthest step reached is persisted in ONE
 * localStorage key (`drift.guidance`, an int 1-4) so a refresh resumes at
 * the furthest event instead of restarting.
 *
 * Steps (1-based; 4 = the finale, auto-hides 5 s after the first sale):
 * 1. 'Hold W to fly toward the star. Press M for the star chart.'
 * 2. 'Press E at a docked ship to go on foot. Find an ore deposit.'
 *    (reached by a dock AFTER flying, or by disembarking)
 * 3. 'Load your ore into the cargo hold (E at your ship), then sell it at
 *    the dock terminal.' (first pickup)
 * 4. 'You are drifting. Good luck.' (first sale — then it hides itself)
 *
 * The spawn-dock edge: the starter ship IS docked at boot, so a naive
 * docked-transition would jump straight to step 2. The machine only counts
 * a dock once it has first seen the ship UNdock (`airborne`) — the first
 * station visit is always after a flight.
 */

import { canonicalJson } from '@shared/canonical';

/** The four hint lines, index = step - 1 (index 3 is the finale). */
export const GUIDANCE_TEXTS = [
  'Hold W to fly toward the star. Press M for the star chart.',
  'Press E at a docked ship to go on foot. Find an ore deposit.',
  'Load your ore into the cargo hold (E at your ship), then sell it at the dock terminal.',
  'You are drifting. Good luck.',
] as const;

/** The finale's lifetime before it auto-hides. */
export const GUIDANCE_FINALE_MS = 5_000;

/** The localStorage key: the furthest step reached (int 1-4). */
export const GUIDANCE_STORAGE_KEY = 'drift.guidance';

export type GuidanceEvent = 'docked' | 'undocked' | 'disembark' | 'pickup' | 'sale' | 'dismiss';

export interface GuidanceState {
  /** The furthest step reached (4 = finale reached or dismissed). */
  furthest: 1 | 2 | 3 | 4;
  /** X pressed — the guidance is over for good (persisted as 4). */
  dismissed: boolean;
  /** Epoch ms the finale first showed (null until the first sale). */
  finaleAt: number | null;
  /** The ship has undocked at least once since boot. */
  airborne: boolean;
}

/** A fresh machine at the given furthest step (4 = already over). */
export function initialGuidance(furthest: 1 | 2 | 3 | 4 = 1): GuidanceState {
  return { furthest, dismissed: furthest === 4, finaleAt: null, airborne: false };
}

function promote(state: GuidanceState, step: 1 | 2 | 3 | 4): GuidanceState {
  return step <= state.furthest ? state : { ...state, furthest: step };
}

/**
 * Pure step function: `state` + one event + the clock → the next state
 * (identity when nothing changed).
 */
export function guidanceAdvance(
  state: GuidanceState,
  event: GuidanceEvent,
  now: number,
): GuidanceState {
  if (state.dismissed) return state;
  switch (event) {
    case 'undocked':
      return state.airborne ? state : { ...state, airborne: true };
    case 'docked':
      return state.airborne ? promote(state, 2) : state;
    case 'disembark':
      return promote(state, 2);
    case 'pickup':
      return promote(state, 3);
    case 'sale': {
      const next = promote(state, 4);
      return next.finaleAt !== null ? next : { ...next, finaleAt: now };
    }
    case 'dismiss':
      return { ...state, dismissed: true };
  }
}

/**
 * The step to SHOW right now (0-based index into GUIDANCE_TEXTS), or null:
 * dismissed, or the finale past its 5 s window.
 */
export function guidanceVisibleStep(state: GuidanceState, now: number): 0 | 1 | 2 | 3 | null {
  if (state.dismissed) return null;
  if (state.furthest === 4) {
    return state.finaleAt !== null && now - state.finaleAt < GUIDANCE_FINALE_MS ? 3 : null;
  }
  return (state.furthest - 1) as 0 | 1 | 2;
}

/** Load the persisted furthest step (absent/corrupt → 1). */
export function loadGuidanceFurthest(): 1 | 2 | 3 | 4 {
  try {
    const raw = localStorage.getItem(GUIDANCE_STORAGE_KEY);
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (n >= 1 && n <= 4) return n as 1 | 2 | 3 | 4;
    }
  } catch {
    // no storage (SSR / test env) → fresh start
  }
  return 1;
}

/** Persist the furthest step (a dismissal persists 4 — it never comes back). */
export function saveGuidanceFurthest(state: GuidanceState): void {
  try {
    localStorage.setItem(GUIDANCE_STORAGE_KEY, String(state.dismissed ? 4 : state.furthest));
  } catch {
    // best effort
  }
}

/* ---------------- the store (subscribe/emit idiom) ---------------- */

const listeners = new Set<() => void>();
let state: GuidanceState = initialGuidance(loadGuidanceFurthest());
let stateJson = canonicalJson(state);

/** Feed one detected event (idempotent — no-op when nothing changed). */
export function guidanceEvent(event: GuidanceEvent, now: number = Date.now()): void {
  const next = guidanceAdvance(state, event, now);
  if (next === state) return;
  const json = canonicalJson(next);
  if (json === stateJson) return;
  state = next;
  stateJson = json;
  saveGuidanceFurthest(state);
  for (const fn of [...listeners]) fn();
}

/** The current machine state. */
export function guidanceState(): GuidanceState {
  return state;
}

/** Subscribe to changes. Calls fn() immediately; returns the unsubscribe. */
export function guidanceSubscribe(fn: () => void): () => void {
  listeners.add(fn);
  fn();
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: clear subscribers + persistence + reset to step 1. */
export function __resetGuidance(): void {
  listeners.clear();
  state = initialGuidance(1);
  stateJson = canonicalJson(state);
  try {
    localStorage.removeItem(GUIDANCE_STORAGE_KEY);
  } catch {
    // no storage
  }
}
