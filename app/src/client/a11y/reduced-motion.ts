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
  type QualityPreset,
  type Settings,
  type SettingKey,
} from '@shared/settings';
import {
  perfProfileFor,
  type DeviceProfile,
  type DeviceProfileChoice,
  type PerfProfileKey,
} from '@shared/perf';
import { setLodRadii } from '@client/world/chunks';
import { applyPerfProfile } from '@client/perf/profile-bridge';

let current: Settings = { ...DEFAULT_SETTINGS };
const listeners = new Set<(s: Settings) => void>();
/**
 * TASK-59: the boot-detection result (detectProfile, set once at app start
 * BEFORE the first world load). 'auto' resolves to it; a manual override
 * (deviceProfile) always wins.
 */
let detectedProfile: DeviceProfile = 'desktop';
/** USER-initiated device-profile changes only (not the boot restore fetch). */
const deviceProfileChangeListeners = new Set<(c: DeviceProfileChoice) => void>();

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
  // TASK-59: the live radii / caps follow the EFFECTIVE key — on a mobile
  // session a quality click re-applies the mobile row (the profile wins).
  const key = effectiveProfileKey();
  setLodRadii(perfProfileFor(key).lodRadii);
  applyPerfProfile(key);
}

/** Set the sensitivity (0.5–2.0, clamped; read on the NEXT input frame). */
export function setSensitivity(value: number): void {
  const v = clampSensitivity(value);
  if (current.sensitivity === v) return;
  commit({ ...current, sensitivity: v });
}

/** TASK-59: record the boot detection result (called once at app start). */
export function setDetectedProfile(p: DeviceProfile): void {
  detectedProfile = p;
}

/** The detected profile (before the app records one, 'desktop'). */
export function detectedProfileValue(): DeviceProfile {
  return detectedProfile;
}

/** TASK-59: the EFFECTIVE device profile — the override, or the detection. */
export function effectiveProfile(): DeviceProfile {
  return current.deviceProfile === 'auto' ? detectedProfile : current.deviceProfile;
}

/**
 * TASK-59: the perf-table key for the effective profile: 'mobile' when the
 * effective profile is mobile (it REPLACES the quality preset), else the
 * quality preset. Read at world load by the WorldManager (star count,
 * atmosphere mode) and the load-time profile apply (radii, FX caps, labels).
 */
export function effectiveProfileKey(): PerfProfileKey {
  return effectiveProfile() === 'mobile' ? 'mobile' : current.quality;
}

/**
 * Set the device-profile override (TASK-59, USER path — the settings panel):
 * notifies the general subscribers AND the user-change listeners (the main
 * app fires the 'Profile applied — re-entering system' toast + the warp
 * re-init from there). NO live re-tuning: the override takes effect at the
 * NEXT world load (the pipeline re-init is not live for mobile-tier cuts).
 */
export function setDeviceProfile(choice: DeviceProfileChoice): void {
  if (current.deviceProfile === choice) return;
  commit({ ...current, deviceProfile: choice });
  for (const listener of deviceProfileChangeListeners) listener(choice);
}

/** Subscribe to USER-initiated device-profile changes; returns unsubscribe. */
export function deviceProfileChangeSubscribe(fn: (c: DeviceProfileChoice) => void): () => void {
  deviceProfileChangeListeners.add(fn);
  return () => {
    deviceProfileChangeListeners.delete(fn);
  };
}

/**
 * Apply a full settings row (the boot fetch from the server). Each field
 * goes through the same live-application path a user change would, so a
 * restored Low session re-tunes the pipeline exactly like a click would.
 */
export function applySettings(s: Settings): void {
  if (current.quality !== s.quality || current.deviceProfile !== s.deviceProfile) {
    commit({ ...current, quality: s.quality, deviceProfile: s.deviceProfile });
    // TASK-59: the live radii are the EFFECTIVE key's — a restored 'mobile'
    // row re-points to the mobile radii (512/3000/3000), not the preset's.
    setLodRadii(perfProfileFor(effectiveProfileKey()).lodRadii);
  } else {
    commit({ ...current });
  }
  // TASK-58: (re)apply the restored preset's tunables (idempotent).
  // TASK-59: 'mobile' REPLACES the preset (the effective key).
  applyPerfProfile(effectiveProfileKey());
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
  detectedProfile = 'desktop';
  setLodRadii(perfProfileFor('high').lodRadii);
  applyPerfProfile('high');
  listeners.clear();
  deviceProfileChangeListeners.clear();
}
