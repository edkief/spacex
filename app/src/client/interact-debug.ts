/**
 * TASK-73: dev-only debug hook (no-op in production builds) — exposes the
 * CURRENT on-foot interaction raycast (the per-frame result the E key
 * dispatches) on `window.__INTERACT__`. Lets the e2e inspect exactly which
 * target / distance the prompt and the dispatch saw (the enter-ship flake:
 * the E press can land one frame after the coasting character crossed the
 * 30° cone or the 3 m sub-prompt boundary).
 */

export interface InteractDebugState {
  /** The raycast's prompt text (null = no target in range / cone). */
  text: string | null;
  /** The raycast's target id (null = hidden). */
  targetId: string | null;
  /** Character ↔ target distance (m; null = hidden). */
  distance: number | null;
  /** The character's PREDICTED feet the raycast anchored on (null = no hit). */
  feet: { x: number; y: number; z: number } | null;
}

declare global {
  interface Window {
    __INTERACT__?: InteractDebugState;
  }
}

/** Install the hook (DEV builds only); returns the live record to update. */
export function installInteractDebug(): InteractDebugState | null {
  if (!import.meta.env.DEV) return null;
  const state: InteractDebugState = { text: null, targetId: null, distance: null, feet: null };
  window.__INTERACT__ = state;
  return state;
}
