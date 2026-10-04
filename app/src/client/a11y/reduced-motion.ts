/**
 * Client settings store (TASK-54; the persistence layer is TASK-55).
 *
 * A tiny reactive store over the shared `Settings` type: consumers
 * (the FX gate in `@client/fx`, the threat ping, the warp overlay)
 * SUBSCRIBE so the toggle takes effect immediately — no restart, no
 * re-render requirement beyond each consumer's own reactivity.
 */
import { DEFAULT_SETTINGS, type Settings, type SettingKey } from '@shared/settings';

let current: Settings = { ...DEFAULT_SETTINGS };
const listeners = new Set<(s: Settings) => void>();

/** Snapshot of the current settings (a COPY — callers may not mutate it). */
export function settingsState(): Settings {
  return { ...current };
}

/** The reduced-motion flag (TASK-54's FX gate reads this). */
export function isReducedMotion(): boolean {
  return current['reduced-motion'];
}

/** Set one setting (no-op when unchanged); notifies subscribers. */
export function setSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  for (const listener of listeners) listener(current);
}

/** Subscribe to settings changes; returns unsubscribe. */
export function settingsSubscribe(listener: (s: Settings) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: restore factory defaults and clear subscriptions. */
export function __resetSettings(): void {
  current = { ...DEFAULT_SETTINGS };
  listeners.clear();
}
