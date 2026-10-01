/**
 * TASK-32: dev-only debug hook (no-op in production builds) — exposes the
 * last SERVER-authoritative self-character state (10 Hz entity_update:
 * pos/rot) + the last input ack seq on `window.__CHAR__`. Lets the e2e
 * assert on-foot movement server-side without a second WS client (one
 * connection per player — the browser owns it while on foot).
 */

export interface CharDebugState {
  /** Feet position from the last self character entity_update. */
  pos: { x: number; y: number; z: number } | null;
  /** Facing quat from the same snapshot (undefined pre-rot wire field). */
  rot?: { x: number; y: number; z: number; w: number };
  /** Last input seq the server APPLIED (0 = none yet). */
  acked: number;
}

declare global {
  interface Window {
    __CHAR__?: CharDebugState;
  }
}

/** Install the hook (DEV builds only); returns the live record to update. */
export function installCharDebug(): CharDebugState | null {
  if (!import.meta.env.DEV) return null;
  const state: CharDebugState = { pos: null, acked: 0 };
  window.__CHAR__ = state;
  return state;
}
