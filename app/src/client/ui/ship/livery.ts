/**
 * Livery persistence — TASK-53 (TASK-21 endpoint).
 *
 * The livery pickers are the only network-touching control in the
 * ship panel, so they debounce: a burst of colour changes collapses
 * into ONE `POST /api/ships/livery` call 500 ms after the last
 * change.
 */

/** The debounce window for livery saves (ms). */
export const LIVERY_DEBOUNCE_MS = 500;

/** The three paint slots a ship carries (TASK-21). */
export interface LiveryColors {
  primary: string;
  secondary: string;
  accent: string;
}

/** Options for {@link createLiverySaver}. */
export interface LiverySaverOptions {
  /** Debounce window in ms (defaults to {@link LIVERY_DEBOUNCE_MS}). */
  delayMs?: number;
  /** Called with the final colour triple when the debounce fires. */
  save: (colors: LiveryColors) => void;
}

/** The saver handle returned by {@link createLiverySaver}. */
export interface LiverySaver {
  /** Schedule a save; the timer restarts on every call. */
  schedule(colors: LiveryColors): void;
  /** Fire the pending save immediately (if any). */
  flush(): void;
  /** Drop the pending save. */
  cancel(): void;
  /** How many saves have actually been issued. */
  readonly callCount: number;
}

/**
 * Create a debounced livery saver. Kept as a plain factory (not a
 * hook) so it can be unit-tested with fake timers and reused by
 * the component through a ref.
 */
export function createLiverySaver(options: LiverySaverOptions): LiverySaver {
  const delayMs = options.delayMs ?? LIVERY_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: LiveryColors | null = null;
  let calls = 0;

  const fire = (): void => {
    if (pending === null) return;
    const colors = pending;
    pending = null;
    calls += 1;
    options.save(colors);
  };

  return {
    schedule(colors: LiveryColors): void {
      pending = colors;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, delayMs);
    },
    flush(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      fire();
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
    get callCount(): number {
      return calls;
    },
  };
}
