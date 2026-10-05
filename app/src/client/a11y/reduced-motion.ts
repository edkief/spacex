/**
 * Client settings store (TASK-54 reduced motion + TASK-55 quality /
 * sensitivity; persistence lands in TASK-55).
 *
 * A tiny reactive store over the shared `Settings` type: consumers
 * (the FX gate in `@client/fx`, the threat ping, the warp overlay, the
 * flight / on-foot input loops, the chunk streamer's live LOD radii)
 * SUBSCRIBE so any change takes effect immediately — no restart, no
 * re-init (the SettingsBridge pattern: the pipeline reads the store per
 * frame / per generation, never at construction).
 */
import {
  clampSensitivity,
  DEFAULT_SETTINGS,
  lodRadiiFor,
  type QualityPreset,
  type Settings,
  type SettingKey,
} from '@shared/settings';
import { setLodRadii } from '@client/world/chunks';

let current: Settings = { ...DEFAULT_SETTINGS };
const listeners = new Set<(s: Settings) => void>();

function commit(next: Settings): void {
  current = next;
  for (const listener of listeners) listener(current);
}

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

/**
 * Set the quality preset (TASK-55, immediate effect): in ADDITION to
 * notifying subscribers, re-points the chunk streamer's LIVE LOD radii
 * (the SettingsBridge — new chunk generations use the new radii, existing
 * chunks keep their LOD until regenerated).
 */
export function setQuality(quality: QualityPreset): void {
  if (current.quality === quality) return;
  commit({ ...current, quality });
  setLodRadii(lodRadiiFor(quality));
}

/** Set the sensitivity (0.5–2.0, clamped; read on the NEXT input frame). */
export function setSensitivity(value: number): void {
  const v = clampSensitivity(value);
  if (current.sensitivity === v) return;
  commit({ ...current, sensitivity: v });
}

/**
 * Apply a full settings row (the boot fetch from the server). Each field
 * goes through the same live-application path a user change would, so a
 * restored Low session re-tunes the pipeline exactly like a click would.
 */
export function applySettings(s: Settings): void {
  if (current.quality !== s.quality) {
    commit({ ...current, quality: s.quality });
    setLodRadii(lodRadiiFor(s.quality));
  } else {
    commit({ ...current });
  }
  const next = { ...current, sensitivity: clampSensitivity(s.sensitivity) };
  if (current.sensitivity !== next.sensitivity) commit(next);
  const rm = s['reduced-motion'];
  if (current['reduced-motion'] !== rm) commit({ ...current, 'reduced-motion': rm });
}

/** Subscribe to settings changes; returns unsubscribe. */
export function settingsSubscribe(listener: (s: Settings) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: restore factory defaults (and the default LOD radii) and clear subscriptions. */
export function __resetSettings(): void {
  current = { ...DEFAULT_SETTINGS };
  setLodRadii(lodRadiiFor(DEFAULT_SETTINGS.quality));
  listeners.clear();
}
