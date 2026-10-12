/**
 * TASK-107: dev-only hover debug hook (no-op in production builds) —
 * exposes the live hover store on `window.__HOVER__` so the e2e can
 * assert the client input state deterministically (the auto-disengage AC:
 * the store is force-offered when the wire regime leaves
 * atmosphere/surface). Like __DRIFT__ / __TOUCH__, installed only when
 * import.meta.env.DEV — production builds never ship it.
 */

import { hoverOn, setHoverOn, toggleHover } from '@client/state/hover';

/** Shape of the debug surface the e2e tests read. */
export interface HoverDebug {
  /** The live hover store (true = the 'hover' tag rides every input frame). */
  readonly on: boolean;
  /** Flip the store (the same one-press path the Space/touch toggle call). */
  toggle: () => void;
  /** Set the store directly (e2e determinism). */
  set: (on: boolean) => void;
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __HOVER__?: HoverDebug;
  }
}

/**
 * Install the hook on window. No-op in production builds (DEV flag false).
 * Called once at module load from main.tsx.
 */
export function installHoverDebug(): void {
  if (!import.meta.env.DEV) return;
  window.__HOVER__ = {
    get on() {
      return hoverOn();
    },
    toggle: () => toggleHover(),
    set: (on) => setHoverOn(on),
  };
}
