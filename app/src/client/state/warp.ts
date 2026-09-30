/**
 * Warp event bus (TASK-7 stub — TASK-8 implements the actual flow).
 *
 * The star chart and the game shell share inter-system warp state through
 * this tiny pub/sub so TASK-8 only has to implement the transition flow and
 * dispatch the same events: the chart already listens and shows its
 * 'Warping...' state from `warp-started`, and clears it on `warp-complete`.
 */

export type WarpEvent =
  | {
      type: 'warp-started';
      fromSystemId: string;
      toSystemId: string;
      etaSeconds: number;
    }
  | {
      type: 'warp-complete';
      toSystemId: string;
    };

export type WarpListener = (event: WarpEvent) => void;

const listeners = new Set<WarpListener>();
let last: WarpEvent | null = null;

/** Subscribe to warp events. Returns the unsubscribe function. */
export function warpSubscribe(fn: WarpListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Dispatch a warp event to every subscriber (and remember it). */
export function dispatchWarpEvent(event: WarpEvent): void {
  last = event;
  for (const fn of [...listeners]) fn(event);
}

/** The most recent warp event, if any (late subscribers can catch up). */
export function lastWarpEvent(): WarpEvent | null {
  return last;
}

/** Test helper: clear subscribers + last event. */
export function __resetWarpState(): void {
  listeners.clear();
  last = null;
}
