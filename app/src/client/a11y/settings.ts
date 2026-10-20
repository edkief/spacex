/**
 * Accessibility settings store — TASK-54.
 *
 * A tiny external store holding the client's accessibility
 * preferences. TASK-55 renders the settings UI; the *store* lives
 * here so the flag has exactly one owner (no prop drilling, no
 * duplicated state) and so the FX layers can read it without
 * importing React.
 *
 * The store persists to `localStorage` under {@link STORAGE_KEY} so
 * a reduced-motion preference survives a reload. The persistence
 * is best-effort: a browser with storage disabled (or a Node test
 * environment) degrades to an in-memory store.
 *
 * @see ./settings.test.ts
 */

/** The localStorage key the settings are persisted under. */
export const STORAGE_KEY = "drift.settings";

/** The settings snapshot shape (frozen — replace it wholesale). */
export interface SettingsSnapshot {
  /**
   * When true the client disables camera shake, slow-mo, particle
   * FX (debris / smoke / trails), the animated threat ping, and the
   * warp streak (a plain fade replaces it).
   *
   * Default: `false` (the spec asks for an opt-in toggle).
   */
  readonly reducedMotion: boolean;
}

/** The default snapshot — reduced motion is opt-in. */
export const DEFAULT_SETTINGS: SettingsSnapshot = { reducedMotion: false };

/** Listener signature for {@link SettingsStore.subscribe}. */
export type SettingsListener = () => void;

/** Minimal storage surface (so tests can pass a fake). */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Options for the settings store constructor. */
export interface SettingsStoreOptions {
  /** Where to persist (defaults to `localStorage` when available). */
  storage?: SettingsStorage | null;
  /** Seed value (used by tests to bypass persistence). */
  initial?: Partial<SettingsSnapshot>;
}

/**
 * The client's accessibility settings store.
 *
 * Subscribe with `useSyncExternalStore(store.subscribe,
 * store.getSnapshot)` (see the `useSettings` hook below).
 */
export class SettingsStore {
  private snapshot: SettingsSnapshot;
  private readonly listeners = new Set<SettingsListener>();
  private readonly storage: SettingsStorage | null;

  constructor(options: SettingsStoreOptions = {}) {
    this.storage = options.storage ?? defaultStorage();
    this.snapshot = { ...DEFAULT_SETTINGS, ...readPersisted(this.storage), ...options.initial };
  }

  /** The current snapshot (stable reference between changes). */
  getSnapshot = (): SettingsSnapshot => this.snapshot;

  /** Subscribe to snapshot changes. Returns an unsubscribe handle. */
  subscribe = (listener: SettingsListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Enable or disable reduced motion. Takes effect immediately. */
  setReducedMotion = (reducedMotion: boolean): void => {
    if (this.snapshot.reducedMotion === reducedMotion) return;
    this.snapshot = { ...this.snapshot, reducedMotion };
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A faulty listener must not break the settings update.
      }
    }
  };

  /** Flip the reduced-motion flag. */
  toggleReducedMotion = (): void => {
    this.setReducedMotion(!this.snapshot.reducedMotion);
  };

  /** Write the current snapshot to storage (best effort). */
  private persist(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.snapshot));
    } catch {
      // Storage may be unavailable (private mode, quota) — the
      // in-memory snapshot still works for this session.
    }
  }
}

/** Read the persisted snapshot (best effort). */
function readPersisted(storage: SettingsStorage | null): Partial<SettingsSnapshot> {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const reducedMotion = (parsed as { reducedMotion?: unknown }).reducedMotion;
    return typeof reducedMotion === "boolean" ? { reducedMotion } : {};
  } catch {
    return {};
  }
}

/** The browser's `localStorage`, or `null` when unavailable. */
function defaultStorage(): SettingsStorage | null {
  try {
    const ls = (globalThis as { localStorage?: SettingsStorage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

/**
 * The process-wide settings store.
 *
 * The FX layers and the settings UI both read this instance so a
 * toggle flip is visible everywhere on the next frame — no restart.
 */
export const settingsStore = new SettingsStore();
