/**
 * Settings REST client — TASK-55.
 *
 * Two thin helpers over `GET`/`PUT /api/players/settings` plus the
 * **debounced saver** the panel uses for the sensitivity slider: a
 * drag emits an `input` event per pixel, so the panel queues the
 * value locally (live, no lag) and this saver collapses the burst
 * into ONE `PUT` 300 ms after the last change.
 *
 * @see ./api.test.ts
 */
import type { Settings } from "@shared/settings.js";
import { sanitizeSettings } from "@shared/settings.js";

/** Debounce window the panel uses before it PUTs the slider value. */
export const SETTINGS_SAVE_DEBOUNCE_MS = 300;

/** Fetch the caller's persisted settings. */
export async function fetchSettings(token: string): Promise<Settings> {
  const res = await fetch("/api/players/settings", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`fetchSettings: ${res.status}`);
  const body = (await res.json()) as { settings?: unknown };
  return sanitizeSettings(body.settings);
}

/**
 * Persist a settings patch. The server merges the patch onto the
 * stored record and echoes the result back (post-clamp), so the
 * returned value is the authoritative one.
 */
export async function saveSettings(token: string, patch: Partial<Settings>): Promise<Settings> {
  const res = await fetch("/api/players/settings", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`saveSettings: ${res.status}`);
  const body = (await res.json()) as { settings?: unknown };
  return sanitizeSettings(body.settings);
}

/** Callbacks for {@link createSettingsSaver}. */
export interface SettingsSaverOptions {
  /** Bearer token; a null token makes every save a no-op. */
  getToken: () => string | null;
  /** How long to wait for silence before PUTting (default 300 ms). */
  debounceMs?: number;
  /** Called after every successful PUT (used to re-hydrate the store). */
  onSaved?: (settings: Settings) => void;
  /** Called on a failed PUT — the UI keeps the local value. */
  onError?: (error: unknown) => void;
  /** Injectable timer (tests drive the clock by hand). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** A debounced settings writer. */
export interface SettingsSaver {
  /** Queue a patch; collapses bursts into one PUT per quiet window. */
  queue(patch: Partial<Settings>): void;
  /** Pending patch, or null when nothing is queued. */
  pending(): Partial<Settings> | null;
  /** PUT the queued patch immediately (no debounce). */
  flush(): Promise<void>;
  /**
   * Drop any queued patch and PUT `patch` right away. Used by the
   * immediate controls (preset switch, reduced-motion toggle,
   * Reset) so a stale slider write can't land after them.
   */
  saveNow(patch: Partial<Settings>): Promise<void>;
  /** Drop a queued patch without sending it. */
  cancel(): void;
  /** Number of PUTs issued so far (test seam). */
  sends(): number;
}

/**
 * Build a debounced saver. Five slider drags inside one window
 * produce exactly ONE `PUT` — the acceptance criterion.
 */
export function createSettingsSaver(options: SettingsSaverOptions): SettingsSaver {
  const debounceMs = options.debounceMs ?? SETTINGS_SAVE_DEBOUNCE_MS;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as number));
  let queued: Partial<Settings> | null = null;
  let handle: unknown = null;
  let sends = 0;
  // Writes are serialised: a preset switch right after a Reset must
  // not race the earlier PUT to the server (the last write has to be
  // the last one *applied*, not merely the last one issued).
  let chain: Promise<void> = Promise.resolve();

  const send = (patch: Partial<Settings>): Promise<void> => {
    const token = options.getToken();
    if (token === null) return Promise.resolve();
    sends += 1;
    chain = chain.then(async () => {
      try {
        const stored = await saveSettings(token, patch);
        options.onSaved?.(stored);
      } catch (err) {
        options.onError?.(err);
      }
    });
    return chain;
  };

  return {
    queue(patch: Partial<Settings>): void {
      queued = { ...queued, ...patch };
      if (handle !== null) clearTimer(handle);
      handle = setTimer(() => {
        handle = null;
        const patchToSend = queued;
        queued = null;
        if (patchToSend !== null) void send(patchToSend);
      }, debounceMs);
    },
    pending(): Partial<Settings> | null {
      return queued;
    },
    async flush(): Promise<void> {
      if (handle !== null) clearTimer(handle);
      handle = null;
      const patchToSend = queued;
      queued = null;
      if (patchToSend !== null) await send(patchToSend);
    },
    async saveNow(patch: Partial<Settings>): Promise<void> {
      if (handle !== null) clearTimer(handle);
      handle = null;
      queued = null;
      await send(patch);
    },
    cancel(): void {
      if (handle !== null) clearTimer(handle);
      handle = null;
      queued = null;
    },
    sends(): number {
      return sends;
    },
  };
}
