/**
 * Warp state machine — TASK-7 + TASK-8.
 *
 * The chart UI (TASK-7) and the warp flow (TASK-8) share one
 * canonical state machine. The chart subscribes so it can render
 * "Warping…" on the source node and disable other interactions
 * while a warp is in flight; TASK-8 drives the transitions.
 *
 * ## State graph
 *
 * ```
 *   idle
 *    │ warp:requested
 *    ▼
 *  warping-in  (overlay plays, typically ~2 s)
 *    │ warp-arrived received
 *    ▼
 *  awaiting     (awaiting world swap)
 *    │ world:swapped
 *    ▼
 *  warping-out  (overlay plays, typically ~2 s)
 *    │ warp:complete
 *    ▼
 *  idle
 * ```
 *
 * Failure paths (rejected warp, system full, etc.) collapse back
 * to `idle` via `warp:failed`. The store surfaces the failure
 * reason so a future TASK-8 hook can render a toast.
 *
 * ## Stub vs real flow
 *
 * TASK-7 (this task) defines the state machine + the `requestWarp`
 * / `warpStarted` / `warpComplete` / `warpFailed` API surface so
 * the chart can subscribe to it. TASK-8 replaces the stub
 * `requestWarp` body with the real WS-send to the server; until
 * then the store is a pure in-process state machine driven only by
 * the local events listed above.
 *
 * ## Determinism
 *
 * The state machine has no time-based transitions (no `setTimeout`
 * inside the store). `requestWarp` → `warpStarted` is a synchronous
 * transition. The chart's 2 s overlay timer lives in the *consumer*
 * (the warp overlay component) so a test can drive the machine
 * directly without dealing with fake timers.
 */
// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The set of legal warp states. Stored as a tagged union so a
 * consumer (the chart, the world manager) can pattern-match on
 * the current state without a separate "is busy" flag.
 *
 * - `idle` — no warp in flight. The Warp button is enabled iff a
 *   target system is also set.
 * - `warping-in` — the 2 s overlay is playing; the chart shows
 *   "Warping…" on the source node. Network request has been sent
 *   or is about to be sent.
 * - `awaiting` — `warp-arrived` frame received; world swap is
 *   about to begin.
 * - `warping-out` — the world has been swapped; the 2 s
 *   warp-out overlay is playing.
 */
export type WarpState =
  | { kind: "idle"; targetSystemId: null }
  | { kind: "warping-in"; targetSystemId: string; startedAtMs: number }
  | { kind: "awaiting"; targetSystemId: string; arrivedAtMs: number }
  | { kind: "warping-out"; targetSystemId: string; swappedAtMs: number };

/** Failure payload — passed through `warp:failed` for toast rendering. */
export interface WarpFailure {
  code: "system-full" | "system-not-found" | "same-system" | "transport-error" | "cancelled";
  message: string;
  targetSystemId: string;
}

/** Events emitted by the store. */
export type WarpEvent =
  | { kind: "warp-started"; targetSystemId: string; startedAtMs: number }
  | { kind: "warp-arrived"; targetSystemId: string; arrivedAtMs: number }
  | { kind: "world-swapped"; targetSystemId: string; swappedAtMs: number }
  | { kind: "warp-complete"; targetSystemId: string; completedAtMs: number }
  | { kind: "warp-failed"; failure: WarpFailure; failedAtMs: number };

/** Subscriber callback signature. */
export type WarpListener = (state: WarpState) => void;

/** Unsubscribe handle returned by `subscribe`. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Convenience: true iff the warp machine is in any "busy" state.
 * The chart uses this to disable the Warp button while a warp is
 * already in flight.
 */
export function isWarpInFlight(state: WarpState): boolean {
  return state.kind !== "idle";
}

/**
 * Convenience: extract the in-flight target system id (or `null`
 * when idle). Used by the chart to label the source node while
 * warping.
 */
export function warpTargetSystemId(state: WarpState): string | null {
  return state.targetSystemId;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * The in-process warp state machine. Owns no timers, no sockets,
 * no globals. The consumer (TASK-8) drives transitions; subscribers
 * react.
 *
 * The `requestWarp(systemId)` action is a pure *intent* call: it
 * transitions to `warping-in` and emits `warp-started`. The actual
 * WS send (TASK-8) happens after the transition so the chart can
 * subscribe and render the overlay before any network work begins.
 */
export class WarpStore {
  private state: WarpState = { kind: "idle", targetSystemId: null };
  private listeners = new Set<WarpListener>();
  /** Optional clock injection for tests; defaults to `Date.now`. */
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Current state (read-only snapshot — never mutate the returned object). */
  get current(): WarpState {
    return this.state;
  }

  /** Subscribe to state changes. Fires immediately with the current state. */
  subscribe(listener: WarpListener): Unsubscribe {
    this.listeners.add(listener);
    // Fire synchronously with the current state so subscribers
    // don't have to call `current` themselves on first attach.
    try {
      listener(this.state);
    } catch {
      // Listener threw — drop it (matches the presence store's
      // faulty-listener tolerance policy).
      this.listeners.delete(listener);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Intent: start warping to `systemId`. Transitions to
   * `warping-in` and emits `warp-started`. No-op if the machine
   * is already busy (the chart disables the Warp button so this
   * shouldn't fire in practice, but we still guard against
   * double-clicks).
   */
  requestWarp(systemId: string, atMs?: number): void {
    if (this.state.kind !== "idle") return;
    const startedAtMs = atMs ?? this.now();
    this.setState({ kind: "warping-in", targetSystemId: systemId, startedAtMs });
  }

  /**
   * TASK-8 (forward-compat): called when the server's
   * `warp-arrived` frame arrives. Transitions `warping-in` →
   * `awaiting`.
   */
  warpArrived(systemId: string, atMs?: number): void {
    if (this.state.kind !== "warping-in") return;
    if (this.state.targetSystemId !== systemId) return;
    const arrivedAtMs = atMs ?? this.now();
    this.setState({ kind: "awaiting", targetSystemId: systemId, arrivedAtMs });
  }

  /**
   * TASK-8 (forward-compat): called when the world manager has
   * finished swapping the scene. Transitions `awaiting` →
   * `warping-out`.
   */
  worldSwapped(systemId: string, atMs?: number): void {
    if (this.state.kind !== "awaiting") return;
    if (this.state.targetSystemId !== systemId) return;
    const swappedAtMs = atMs ?? this.now();
    this.setState({ kind: "warping-out", targetSystemId: systemId, swappedAtMs });
  }

  /**
   * TASK-8 (forward-compat): called when the warp-out overlay
   * finishes. Transitions `warping-out` → `idle`.
   */
  warpComplete(systemId: string, atMs?: number): void {
    if (this.state.kind !== "warping-out") return;
    if (this.state.targetSystemId !== systemId) return;
    const completedAtMs = atMs ?? this.now();
    this.setState({ kind: "idle", targetSystemId: null });
    void completedAtMs;
  }

  /**
   * Failure path: collapse back to `idle`. Called by TASK-8 on a
   * server-side rejection (`system-full`, `system-not-found`) or
   * a transport error.
   */
  warpFailed(failure: WarpFailure, atMs?: number): void {
    const failedAtMs = atMs ?? this.now();
    this.setState({ kind: "idle", targetSystemId: null });
    void failure;
    void failedAtMs;
  }

  /**
   * Convenience for tests + TASK-8: derive a `WarpFailure` from a
   * rejection payload. Tagged so the toast component can switch
   * on `code` without re-parsing the message.
   *
   * The payload shape is declared as a structural type (rather
   * than a `PayloadFor<...>` lookup) because `warp_rejected`
   * lives in TASK-8's protocol patch — TASK-7 ships the state
   * machine + failure type in advance so the chart can subscribe
   * to failure events without circular protocol dependencies.
   */
  static failureFromRejected(payload: {
    code: WarpFailure["code"];
    message: string;
    targetSystemId: string;
  }): WarpFailure {
    return {
      code: payload.code,
      message: payload.message,
      targetSystemId: payload.targetSystemId,
    };
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private setState(next: WarpState): void {
    if (sameState(this.state, next)) return;
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // Listener threw — drop it from the subscriber set so a
        // single buggy listener can't crash the warp flow.
        this.listeners.delete(listener);
      }
    }
  }
}

/** Reference-equality helper for state transitions (same kind + id). */
function sameState(a: WarpState, b: WarpState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.targetSystemId !== b.targetSystemId) return false;
  return true;
}
