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

import {
  clampSensitivity,
  DEFAULT_SETTINGS as SHARED_DEFAULT_SETTINGS,
  sanitizeSettings,
  type QualityPreset,
  type Settings,
} from "@shared/settings.js";

/**
 * The settings snapshot — the shared {@link Settings} record
 * (quality preset + mouse sensitivity + reduced motion). TASK-55
 * widened the TASK-54 flag into the full record; the type alias is
 * kept so the existing FX / overlay call sites stay readable.
 */
export type SettingsSnapshot = Settings;

/** The default snapshot — high quality, 1.0× sensitivity, motion on. */
export const DEFAULT_SETTINGS: SettingsSnapshot = SHARED_DEFAULT_SETTINGS;

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
    this.snapshot = sanitizeSettings({
      ...readPersisted(this.storage),
      ...options.initial,
    });
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
    this.commit({ ...this.snapshot, reducedMotion });
  };

  /** Flip the reduced-motion flag. */
  toggleReducedMotion = (): void => {
    this.setReducedMotion(!this.snapshot.reducedMotion);
  };

  /**
   * TASK-55: switch the quality preset. Immediate (no debounce) —
   * the pipeline re-tunes on its next tick via the SettingsBridge.
   */
  setQuality = (quality: QualityPreset): void => {
    this.commit({ ...this.snapshot, quality });
  };

  /**
   * TASK-55: set the mouse-look multiplier. Clamped to
   * `[0.5, 2.0]` on the 0.1 step; applies on the next input frame.
   */
  setSensitivity = (sensitivity: number): void => {
    this.commit({ ...this.snapshot, sensitivity: clampSensitivity(sensitivity) });
  };

  /**
   * TASK-55: replace the whole snapshot (session restore). Values
   * are sanitised first, so a corrupt server payload degrades to
   * the defaults rather than poisoning the client.
   */
  hydrate = (patch: unknown): void => {
    this.commit(sanitizeSettings(patch));
  };

  /** TASK-55: restore the shipped defaults. */
  reset = (): void => {
    this.commit(DEFAULT_SETTINGS);
  };

  /**
   * Shared commit path: no-op on an unchanged snapshot (so an
   * unchanged `PUT` never re-renders the panel), then notify.
   */
  private commit(next: SettingsSnapshot): void {
    if (
      next.quality === this.snapshot.quality &&
      next.sensitivity === this.snapshot.sensitivity &&
      next.reducedMotion === this.snapshot.reducedMotion
    ) {
      return;
    }
    this.snapshot = next;
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A faulty listener must not break the settings update.
      }
    }
  }

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
    const record = parsed as Record<string, unknown>;
    // The shared record is readonly, so the patch is assembled as a
    // mutable local before it is handed to the store's constructor.
    const patch: {
      reducedMotion?: boolean;
      quality?: QualityPreset;
      sensitivity?: number;
    } = {};
    if (typeof record.reducedMotion === "boolean") patch.reducedMotion = record.reducedMotion;
    if (typeof record.quality === "string") {
      patch.quality = record.quality as QualityPreset;
    }
    if (typeof record.sensitivity === "number") patch.sensitivity = record.sensitivity;
    return patch;
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
