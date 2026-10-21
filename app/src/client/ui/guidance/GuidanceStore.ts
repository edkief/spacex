/**
 * Guidance state machine (TASK-56).
 *
 * One owner per app instance: advances through the four hint steps
 * as the player docks, disembarks, mines, and sells, persists the
 * furthest-reached step in one `localStorage` key, and lets the
 * player dismiss everything with a single `X`.
 *
 * @see ./steps.ts for the step table + storage helpers.
 * @see ../guidance.ts for the barrel re-export.
 */
// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/** Options for `GuidanceStore`. */
export interface GuidanceStoreOptions {
  /** Storage backend (defaults to `localStorage` when available). */
  storage?: GuidanceStorage | null;
  /** Seed value (used by tests to bypass persistence). */
  initial?: { step?: number | null; dismissed?: boolean };
  /** Override the wall clock. */
  now?: () => number;
}

/**
 * The guidance state machine. One owner per app instance.
 *
 * ## Lifecycle
 *
 *   - Fresh player (`storage === null` or key missing) → start at
 *     `STEP_FLY` (step 0) with `furthest = 0`.
 *   - Returning player with a persisted step → start at that step
 *     (no rewind). The headline test asserts a mid-flight refresh
 *     keeps the player on step 1+.
 *
 * ## Event semantics
 *
 * Each server-independent event advances BOTH the current step AND
 * the `furthest` counter. The state machine is monotonic — events
 * never rewind, even if they arrive out of order (e.g. the player
 * disembarks then re-boards, the first sale arrives after a
 * re-render). The store just refuses to move backwards.
 *
 * `dismiss` is the user's "off" switch. It's sticky — once the
 * store sees it, no event re-shows the hint line until the page is
 * reloaded with a fresh store (which is what the player expects).
 */
import {
  clearStep,
  defaultStorage,
  readStep,
  targetStepFor,
  writeStep,
  STEP_FLY,
  STEP_FINALE,
  type GuidanceEvent,
  type GuidanceListener,
  type GuidanceState,
  type GuidanceStorage,
} from "./steps.js";

export class GuidanceStore {
  private state: GuidanceState;
  private readonly listeners = new Set<GuidanceListener>();
  private readonly storage: GuidanceStorage | null;
  private readonly now: () => number;

  constructor(options: GuidanceStoreOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.now = options.now ?? (() => Date.now());
    const persisted = readStep(this.storage);
    const seedStep = options.initial?.step ?? persisted;
    const seedDismissed = options.initial?.dismissed ?? false;
    this.state = {
      // Fresh player → start at step 0 (the first hint).
      step: seedDismissed ? null : (seedStep ?? STEP_FLY),
      furthest: seedStep ?? STEP_FLY,
      dismissed: seedDismissed,
      revision: 0,
      finaleStartedAtMs: null,
    };
  }

  /** Stable snapshot for `useSyncExternalStore`. */
  getSnapshot = (): GuidanceState => this.state;

  /** Subscribe to state changes. Returns an unsubscribe handle. */
  subscribe = (listener: GuidanceListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Process an event. Out-of-order events are silently ignored
   * (the furthest counter only ever moves forward).
   *
   * The store also handles the auto-hide for the finale: when an
   * event advances the player into `STEP_FINALE`, the snapshot
   * carries `finaleStartedAtMs` so the React overlay can fire its
   * 5 s hide timer.
   */
  recordEvent(event: GuidanceEvent): void {
    if (this.state.dismissed) return;
    if (event === "dismiss") {
      this.state = {
        ...this.state,
        step: null,
        dismissed: true,
        revision: this.state.revision + 1,
      };
      clearStep(this.storage);
      this.notify();
      return;
    }
    const target = targetStepFor(event);
    if (target === null) return;
    if (target <= this.state.furthest) return;
    const next: GuidanceState = {
      ...this.state,
      step: target,
      furthest: target,
      revision: this.state.revision + 1,
      finaleStartedAtMs: target === STEP_FINALE ? this.now() : this.state.finaleStartedAtMs,
    };
    this.state = next;
    writeStep(this.storage, target);
    this.notify();
  }

  /**
   * Programmatic hide without setting the dismissed flag. Used by
   * the auto-hide timer for `STEP_FINALE`. The persisted `furthest`
   * is preserved so a refresh shows the dismissed-or-finale state.
   */
  hide(): void {
    if (this.state.step === null) return;
    this.state = {
      ...this.state,
      step: null,
      revision: this.state.revision + 1,
    };
    this.notify();
  }

  /**
   * Test seam — drives a snapshot in directly without going
   * through the event API. Production never calls this.
   */
  __setForTest(next: Partial<GuidanceState>): void {
    this.state = {
      ...this.state,
      ...next,
      revision: this.state.revision + 1,
    };
    this.notify();
  }

  /** Notify subscribers. Faulty listeners are swallowed. */
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // A faulty listener must not break the loop.
      }
    }
  }
}
