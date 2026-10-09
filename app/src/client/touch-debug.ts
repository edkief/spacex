/**
 * TASK-91: dev-only touch debug hook (no-op in production builds) — exposes
 * the ACTIVE touch channels on `window.__TOUCH__` plus a `setChannel`
 * passthrough, so the e2e drives the channels DETERMINISTICALLY (synthetic
 * pointer-capture gestures on the joysticks are flaky in headless — the dev
 * hook is the reliable input-adjacent path, same pattern as interact-debug).
 *
 * `channels` is a live getter: it always reads the source's current state
 * (a joystick move made by a real finger shows up here too), and
 * `setChannel` / `clear` delegate to the bound source.
 */

import type { TouchChannels, TouchInputSource } from '@client/input/touch';

export interface TouchDebugState {
  /** Snapshot of the source's ACTIVE channels (live). */
  readonly channels: TouchChannels;
  /** Delegate to the source (the e2e drives the flight channels this way). */
  setChannel: (channels: Partial<TouchChannels>) => void;
  /** Reset every channel off (delegates to the source). */
  clear: () => void;
}

declare global {
  interface Window {
    __TOUCH__?: TouchDebugState;
  }
}

/** The live source (bound by main.tsx once the ref exists). */
let boundSource: (() => TouchInputSource | null) | null = null;

/** Install the hook (DEV builds only); returns the live record to use. */
export function installTouchDebug(): TouchDebugState | null {
  if (!import.meta.env.DEV) return null;
  const state: TouchDebugState = {
    get channels() {
      return boundSource?.()?.snapshot() ?? {};
    },
    setChannel: (channels) => boundSource?.()?.setChannel(channels),
    clear: () => boundSource?.()?.clear(),
  };
  window.__TOUCH__ = state;
  return state;
}

/** Bind the live source (main.tsx passes a lazy getter over its ref). */
export function bindTouchDebug(
  state: TouchDebugState | null,
  getSource: () => TouchInputSource | null,
): void {
  if (!state) return; // production build — nothing to bind
  boundSource = getSource;
}
