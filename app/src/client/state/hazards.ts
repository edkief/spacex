/**
 * Client hazard state (TASK-48.2) — the single source of truth for the
 * 'hazard' HUD: the player's personal exposure (shield) pool, the hazard
 * kind they stand in (the radiation meter), and the 5 s 'SHIELD BURN'
 * knock-down.
 *
 * Driven exclusively by the server's per-connection 10 Hz 'hazard' frame
 * (schemas.ts — private per-player state, like 'mining'). Display state
 * only: ALL exposure math lives server-side (shared/world/hazards.ts) and
 * the client runs no timers of its own. Follows the subscribe/emit idiom of
 * state/docked.ts + state/cargo.ts: set → emit only on change (stable JSON
 * comparison); late subscribers catch up. HUD only.
 */

import { canonicalJson } from '@shared/canonical';
import { EXPOSURE_MAX } from '@shared/world/hazards';

/** The wire shape of the 'hazard' frame (server-originated, schemas.ts). */
export interface HazardFrame {
  /** The personal exposure pool 0..50 (server authority). */
  exposure: number;
  /** The hazard kind the player stands in (omitted when clear). */
  inside?: 'storm' | 'radzone';
  /** Epoch-ms end of the 5 s knock-down (omitted when not recovering). */
  recoveringUntil?: number;
}

/** The hazard view the HUD renders. */
export interface HazardState {
  /** The personal exposure pool 0..50. */
  exposure: number;
  /** The hazard kind the player stands in (null when clear). */
  inside: 'storm' | 'radzone' | null;
  /** The 5 s 'SHIELD BURN' knock-down is active. */
  recovering: boolean;
  /** Epoch-ms end of the knock-down (null when not recovering) — TASK-52's HUD countdown. */
  recoveringUntil: number | null;
}

type HazardListener = (state: HazardState) => void;

const CLEAR: HazardState = {
  exposure: EXPOSURE_MAX,
  inside: null,
  recovering: false,
  recoveringUntil: null,
};

const listeners = new Set<HazardListener>();
let current: HazardState = CLEAR;
let currentJson = canonicalJson(CLEAR);

function emit(next: HazardState): void {
  const json = canonicalJson(next);
  if (json === currentJson) return;
  current = next;
  currentJson = json;
  for (const fn of [...listeners]) fn(next);
}

/**
 * Feed a 'hazard' frame into the store (the main.tsx message handler).
 * `recovering` is derived from the frame's deadline AT FRAME TIME — the
 * 10 Hz cadence keeps the prompt within one frame of the true end, and no
 * client-side timer is needed.
 */
export function setHazardFrame(frame: HazardFrame): void {
  const until = frame.recoveringUntil ?? 0;
  const recovering = until > Date.now();
  emit({
    exposure: frame.exposure,
    inside: frame.inside ?? null,
    recovering,
    recoveringUntil: recovering ? until : null,
  });
}

/** Clear the store (system swap / re-entry — the frames stop on foot-out). */
export function clearHazard(): void {
  emit(CLEAR);
}

/** The current hazard view. */
export function hazardState(): HazardState {
  return current;
}

/**
 * Subscribe to hazard-state changes. Calls fn(currentState) immediately;
 * returns the unsubscribe.
 */
export function hazardStateSubscribe(fn: HazardListener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: reset (mirrors __resetDockedIndicator). */
export function __resetHazards(): void {
  listeners.clear();
  current = CLEAR;
  currentJson = canonicalJson(CLEAR);
}
