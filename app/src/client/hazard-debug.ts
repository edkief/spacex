/**
 * TASK-48.2: dev-only debug hook (no-op in production builds) — exposes the
 * hazard store's live state (exposure, inside, recovering) on
 * `window.__HAZARD__`. Lets the e2e (TASK-48.4) assert `exposure < 50`
 * after standing in a hazard cell without parsing the DOM (the hook is a
 * read-through view over state/hazards — it never goes stale, so no
 * update plumbing is needed in main.tsx).
 */

import { hazardState } from '@client/state/hazards';

export interface HazardDebugState {
  /** The personal exposure pool 0..50 (raw number — the e2e asserts on it). */
  exposure: number;
  /** The hazard kind the player stands in (null when clear). */
  inside: 'storm' | 'radzone' | null;
  /** The 5 s 'SHIELD BURN' knock-down is active. */
  recovering: boolean;
}

declare global {
  interface Window {
    __HAZARD__?: HazardDebugState;
  }
}

/** Install the hook (DEV builds only); returns the live record. */
export function installHazardDebug(): HazardDebugState | null {
  if (!import.meta.env.DEV) return null;
  const state: HazardDebugState = {
    get exposure() {
      return hazardState().exposure;
    },
    get inside() {
      return hazardState().inside;
    },
    get recovering() {
      return hazardState().recovering;
    },
  };
  window.__HAZARD__ = state;
  return state;
}
