/**
 * Inter-system warp (TASK-8): shared warp state + the transition controller.
 *
 * The star chart dispatches 'warp-started' on this bus (TASK-7 wiring) and
 * mirrors the state ('Warping…' on the source node, Warp button disabled).
 * The WarpController owns the state machine:
 *
 *   idle → warping-in (2 s) → awaiting (network) → warping-out (2 s) → idle
 *                failure at any point  ───────────────────────────────→ idle + onFailed
 *
 * The world swap itself happens on the warp_arrived snapshot (the session
 * routes it through onSnapshot); the controller only sequences the two
 * 2 s rendered transitions around the round trip — no loading screen.
 */

import type { StateSnapshot } from '@shared/protocol/schemas';
import { WarpRejectedError } from '@client/net/session';

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
    }
  | {
      type: 'warp-failed';
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

/** Test helper: clear subscribers + last event + phase store. */
export function __resetWarpState(): void {
  listeners.clear();
  last = null;
  __resetWarpPhase();
}

/** Phases of the warp transition (spec step 3 state machine). */
export type WarpPhase = 'idle' | 'warping-in' | 'awaiting' | 'warp-out';

type PhaseListener = (phase: WarpPhase) => void;
const phaseListeners = new Set<PhaseListener>();
let currentPhase: WarpPhase = 'idle';

/** Subscribe to warp phase changes (overlay fades are driven by phases). */
export function warpPhaseSubscribe(fn: PhaseListener): () => void {
  phaseListeners.add(fn);
  fn(currentPhase); // current phase immediately (late subscribers catch up)
  return () => {
    phaseListeners.delete(fn);
  };
}

/** The current warp phase (idle when no warp is in flight). */
export function warpPhase(): WarpPhase {
  return currentPhase;
}

/** Called by the WarpController on every phase transition. */
export function setWarpPhase(phase: WarpPhase): void {
  if (phase === currentPhase) return;
  currentPhase = phase;
  for (const fn of [...phaseListeners]) fn(phase);
}

/** Test helper: reset the phase store. */
export function __resetWarpPhase(): void {
  phaseListeners.clear();
  currentPhase = 'idle';
}

/** The 2 s in / 2 s out (spec: total warp 3–5 s incl. network). */
export const WARP_IN_MS = 2_000;
export const WARP_OUT_MS = 2_000;
/** Give up on the warp_arrived round trip after this long. */
export const WARP_AWAIT_TIMEOUT_MS = 10_000;

export interface WarpControllerOptions {
  /**
   * Send the WS 'warp' frame; resolves with the target snapshot when the
   * server confirms (warp_arrived), rejects (WarpRejectedError / network
   * error) when it does not.
   */
  requestWarp: (toSystemId: string) => Promise<StateSnapshot>;
  /** A warp fully completed (warp-out finished). */
  onArrived: (toSystemId: string) => void;
  /** A warp failed (server rejection or timeout) with a UI-ready reason. */
  onFailed: (reason: string) => void;
  warpingInMs?: number;
  warpingOutMs?: number;
  awaitingTimeoutMs?: number;
  /** Injectable timer (tests use fake delays). */
  delay?: (ms: number) => Promise<void>;
}

/**
 * One controller per game session. `start` is idempotent-guarded: a second
 * start while any phase is active returns false (the Warp button is also
 * disabled from the warp-started event, so the UI never double-fires).
 */
export class WarpController {
  phase: WarpPhase = 'idle';
  /** The destination of the in-flight warp (null when idle). */
  targetSystemId: string | null = null;

  private readonly options: WarpControllerOptions;
  private readonly delay: (ms: number) => Promise<void>;
  /** Bumped to invalidate a running flow (defensive; phases guard already). */
  private generation = 0;

  constructor(options: WarpControllerOptions) {
    this.options = options;
    this.delay = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** Begin a warp. Returns false when one is already in flight. */
  start(fromSystemId: string, toSystemId: string, etaSeconds: number): boolean {
    if (this.phase !== 'idle' || fromSystemId === toSystemId) return false;
    this.transition('warping-in');
    this.targetSystemId = toSystemId;
    dispatchWarpEvent({ type: 'warp-started', fromSystemId, toSystemId, etaSeconds });
    const generation = this.generation;
    void this.run(generation, toSystemId);
    return true;
  }

  /** Phase transition + broadcast (the overlay fades track these). */
  private transition(next: WarpPhase): void {
    this.phase = next;
    setWarpPhase(next);
  }

  private async run(generation: number, toSystemId: string): Promise<void> {
    // Read through a function: fail()/abort() mutate this.phase from other
    // async paths, so a plain property read would be over-narrowed by TS.
    const phase = (): WarpPhase => this.phase;
    const guard = (): boolean => this.generation === generation && phase() !== 'idle';

    // 1. Warp-in: the 2 s rendered streak transition, THEN the request.
    await this.delay(this.options.warpingInMs ?? WARP_IN_MS);
    if (!guard() || phase() !== 'warping-in') return;

    // 2. Awaiting: the server moves the ship; warp_arrived (or an error)
    //    settles it. A timeout counts as failure — the client rolls back.
    this.transition('awaiting');
    const timedOut = this.delay(this.options.awaitingTimeoutMs ?? WARP_AWAIT_TIMEOUT_MS).then(
      () => 'timeout' as const,
    );
    const settled = this.options
      .requestWarp(toSystemId)
      .then(() => 'ok' as const)
      .catch((err: unknown) => err as Error);
    const result = await Promise.race([settled, timedOut]);
    if (!guard() || phase() !== 'awaiting') return;
    if (result === 'timeout' || result instanceof Error) {
      this.fail(result instanceof Error ? result.message : 'warp timed out');
      return;
    }

    // 3. Warp-out: the world is already swapped (warp_arrived snapshot);
    //    play the 2 s exit transition, then resume normal flight.
    this.transition('warp-out');
    await this.delay(this.options.warpingOutMs ?? WARP_OUT_MS);
    if (!guard() || phase() !== 'warp-out') return;

    this.transition('idle');
    this.targetSystemId = null;
    dispatchWarpEvent({ type: 'warp-complete', toSystemId });
    this.options.onArrived(toSystemId);
  }

  /** failure → idle + warp-failed event + UI reason (toast). */
  private fail(reason: string): void {
    this.transition('idle');
    const to = this.targetSystemId ?? '';
    this.targetSystemId = null;
    dispatchWarpEvent({ type: 'warp-failed', toSystemId: to });
    this.options.onFailed(
      reason && reason.includes('full') && reason.toLowerCase().includes('system')
        ? 'System full'
        : `Warp failed: ${reason}`,
    );
  }

  /** Test/teardown helper: abandon any in-flight flow. */
  abort(): void {
    this.generation += 1;
    if (this.phase !== 'idle') {
      this.transition('idle');
      this.targetSystemId = null;
      dispatchWarpEvent({ type: 'warp-failed', toSystemId: '' });
    }
  }
}

export { WarpRejectedError };
