/**
 * Keyboard state — TASK-74.
 *
 * A tiny subscriber that tracks which game keys are currently
 * held. The `inputPump` reads the live `Set<KeyboardEvent.code>`
 * once per render frame and projects it onto the axes the
 * `LocalInput` schema expects (thrust, turn, pitch, yaw).
 *
 * Design rules (per spec):
 *   - `keydown` / `keyup` mutate a `Set` of `KeyboardEvent.code`
 *     values (the wire-stable Physical Key, not the localized
 *     `event.key`).
 *   - `blur` + `visibilitychange === "hidden"` clear the set so
 *     an alt-tab doesn't leave the ship pinned at full throttle
 *     when the player comes back.
 *   - `preventDefault` only fires for keys the controls manager
 *     has mapped to a game action — chat text input + dev
 *     shortcuts (F3 debug overlay, M chart, etc.) get the
 *     default browser behaviour.
 *
 * No three.js / no React / no `Date.now` — the pump drives the
 * time. Module is dependency-free so unit tests run under Node.
 */

/**
 * The set of held key codes the pump reads from. The `inputPump`
 * iterates this set every render frame, so the implementation
 * favours the cheapest possible data structure.
 */
export type HeldKeySet = ReadonlySet<string>;

/** Subscriber callback fired whenever the held-set changes. */
export type HeldKeysListener = (held: HeldKeySet) => void;

/** Options for {@link installKeyboardState}. */
export interface KeyboardStateOptions {
  /** Game keys to track (defaults to every binding in
   *  `scheme.keyBindings`). Used as the `preventDefault` filter. */
  gameKeys?: ReadonlySet<string>;
  /** Optional clock for tests (defaults to `Date.now`). */
  now?: () => number;
  /** Optional document override for tests (defaults to
   *  `globalThis.document` in the browser). */
  document?: Document | null;
  /** Optional window override (defaults to `globalThis`). */
  window?: Window | null;
}

/**
 * The keyboard state tracker. Install once per mount; tear down
 * via the returned `dispose()` to release the listeners.
 *
 * The held-set is exposed via:
 *   - {@link KeyboardState.held} — synchronous read (the pump calls
 *     this per frame).
 *   - {@link KeyboardState.subscribe} — async fan-out for HUD or
 *     debug overlays.
 */
export class KeyboardState {
  readonly #held: Set<string> = new Set();
  readonly #listeners: Set<HeldKeysListener> = new Set();
  #disposed = false;

  constructor(opts: KeyboardStateOptions = {}) {
    // The gameKeys filter lives on the install-time options; we
    // never read it here (preventDefault is the install path's
    // concern). Marking it as unused keeps the API surface
    // tight — tests assert it through the install-time options
    // bag.
    void opts;
  }

  /** The currently-held key codes (read-only view). Cheap — O(1). */
  get held(): HeldKeySet {
    return this.#held;
  }

  /** Register a listener that fires whenever the held-set changes. */
  subscribe(listener: HeldKeysListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Clear every held key. Called on blur + visibility-hidden. */
  clear(): void {
    if (this.#held.size === 0) return;
    this.#held.clear();
    this.#notify();
  }

  /** Test seam — record a keydown. Production goes through the
   *  browser listener installed by `installKeyboardState`. */
  recordKeyDown(code: string): void {
    if (!this.#held.has(code)) {
      this.#held.add(code);
      this.#notify();
    }
  }

  /** Test seam — record a keyup. */
  recordKeyUp(code: string): void {
    if (this.#held.has(code)) {
      this.#held.delete(code);
      this.#notify();
    }
  }

  #notify(): void {
    if (this.#listeners.size === 0) return;
    // Snapshot the listener set so an unsubscribe mid-iteration
    // doesn't perturb the loop. The `held` set is fresh by the
    // time the listeners run so they see the post-mutation state.
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#held);
      } catch {
        // swallow — a faulty subscriber must not break the
        // keyboard input pipeline.
      }
    }
  }

  /** Mark the instance disposed (no-op listeners should still
   *  fire if the host failed to call `dispose()` exactly). */
  get isDisposed(): boolean {
    return this.#disposed;
  }

  setDisposed(value: boolean): void {
    this.#disposed = value;
  }
}

/**
 * Install `keydown` / `keyup` / `blur` / `visibilitychange`
 * listeners on the browser and pipe them into a fresh
 * `KeyboardState`. Returns the state + a `dispose()` that
 * removes every listener (idempotent).
 */
export function installKeyboardState(opts: KeyboardStateOptions = {}): {
  state: KeyboardState;
  dispose(): void;
} {
  const state = new KeyboardState(opts);
  // `typeof window` is the standard Node/browser split. Tests
  // that don't pass an explicit document get a state with no
  // listener attached — `recordKeyDown` / `recordKeyUp` cover
  // them.
  const win = opts.window ?? (typeof window !== "undefined" ? window : null);
  const doc = opts.document ?? (typeof document !== "undefined" ? document : null);
  if (win === null || doc === null) {
    return {
      state,
      dispose: () => {
        state.setDisposed(true);
      },
    };
  }
  const gameKeys = opts.gameKeys ?? null;
  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.repeat) return; // ignore auto-repeat so thrust doesn't pulse.
    state.recordKeyDown(e.code);
    if (gameKeys !== null && gameKeys.has(e.code)) {
      e.preventDefault();
    }
  };
  const onKeyUp = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    state.recordKeyUp(e.code);
    if (gameKeys !== null && gameKeys.has(e.code)) {
      e.preventDefault();
    }
  };
  const onBlur = (): void => {
    state.clear();
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === "hidden") {
      state.clear();
    }
  };
  win.addEventListener("keydown", onKeyDown);
  win.addEventListener("keyup", onKeyUp);
  win.addEventListener("blur", onBlur);
  doc.addEventListener("visibilitychange", onVisibility);
  return {
    state,
    dispose: () => {
      state.setDisposed(true);
      win.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("keyup", onKeyUp);
      win.removeEventListener("blur", onBlur);
      doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

/**
 * Build the set of physical-key codes that count as "game keys"
 * for a given `ControlScheme`. Used to filter `preventDefault`
 * so non-game keys (volume, browser shortcuts, etc.) pass
 * through.
 */
export function gameKeysForScheme(scheme: {
  keyBindings: ReadonlyArray<{ action: string; key: string }>;
}): Set<string> {
  const out = new Set<string>();
  for (const binding of scheme.keyBindings) out.add(binding.key);
  return out;
}
