/**
 * TASK-108: dev-only boost debug hook (no-op in production builds) —
 * exposes the live boost store on `window.__BOOST__` so the e2e can
 * assert the client input state deterministically (the auto-disengage AC:
 * the store is force-offered when the wire regime leaves space). Like
 * __HOVER__ / __DRIFT__ / __TOUCH__, installed only when
 * import.meta.env.DEV — production builds never ship it.
 */

import { boostOn, setBoostOn, toggleBoost } from '@client/state/boost';

/** Shape of the debug surface the e2e tests read. */
export interface BoostDebug {
  /** The live boost store (true = the 'boost' tag rides every input frame). */
  readonly on: boolean;
  /** Flip the store (the same one-press path the Shift/touch toggle call). */
  toggle: () => void;
  /** Set the store directly (e2e determinism). */
  set: (on: boolean) => void;
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __BOOST__?: BoostDebug;
  }
}

/**
 * Install the hook on window. No-op in production builds (DEV flag false).
 * Called once at module load from main.tsx.
 */
export function installBoostDebug(): void {
  if (!import.meta.env.DEV) return;
  window.__BOOST__ = {
    get on() {
      return boostOn();
    },
    toggle: () => toggleBoost(),
    set: (on) => setBoostOn(on),
  };
}
