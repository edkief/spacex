/**
 * Device profile selection — TASK-59 (the 30 fps mobile floor).
 *
 * Two inputs decide which perf profile the client renders with:
 *
 *   - the **override** the player picked in Settings (`auto` /
 *     `desktop` / `mobile`, persisted with the settings record), and
 *   - the **detected** device, read from `navigator` on boot.
 *
 * ```
 * override = "auto"  ->  detectProfile(navigator)   // heuristic
 * override = "mobile" ->  "mobile"                  // forced 30 fps floor
 * override = "desktop"->  the quality preset's own profile
 * ```
 *
 * The heuristic is a **pure function** over a plain signals object
 * so it can be unit-tested with fake navigator values (no jsdom, no
 * browser): a touch device that reports ≤ 8 GB of device memory or
 * ≤ 4 logical cores is a mid-range phone and gets the Mobile
 * profile. Everything else stays on the desktop profile.
 *
 * Nothing here touches gameplay — the profile is a rendering /
 * streaming budget only (see `PERF_RENDER_FIELDS` in `perf.ts`).
 *
 * @see ./deviceProfile.test.ts
 */

import { perfProfileFor, PERF_PROFILES, type PerfProfile, type PerfProfileId } from "./perf.js";
import type { DeviceProfile, QualityPreset, Settings } from "./settings.js";

/** The signals the heuristic reads off `navigator`. */
export interface DeviceSignals {
  /** `navigator.maxTouchPoints` — 0 on a desktop. */
  readonly maxTouchPoints: number;
  /** `navigator.deviceMemory` in GB (Chromium only; undefined elsewhere). */
  readonly deviceMemory?: number;
  /** `navigator.hardwareConcurrency` — logical cores. */
  readonly hardwareConcurrency?: number;
}

/** Memory ceiling (GB) at or below which a touch device is "mid-range". */
export const MOBILE_MAX_DEVICE_MEMORY_GB = 8;
/** Core ceiling at or below which a touch device is "mid-range". */
export const MOBILE_MAX_HARDWARE_CONCURRENCY = 4;

/** The toast shown when a profile override lands on the next world load. */
export const PROFILE_APPLIED_NOTICE = "Profile applied — re-entering system";

/** The two detected device kinds (the `desktop` kind is then refined
 *  by the player's quality preset — see {@link resolveProfileId}). */
export type DetectedProfile = "desktop" | "mobile";

/**
 * The pure heuristic. Mobile when the device has a touch screen
 * **and** looks mid-range: ≤ 8 GB device memory, or ≤ 4 logical
 * cores. Unknown / missing signals are treated as "not mid-range"
 * (a Firefox phone without `deviceMemory` but 8 cores keeps the
 * desktop profile, which is the conservative choice for a strong
 * handset).
 */
export function detectProfile(signals: DeviceSignals): DetectedProfile {
  const touch = (signals.maxTouchPoints ?? 0) > 0;
  if (!touch) return DETECTED_FALLBACK_PROFILE;
  const weakMemory =
    typeof signals.deviceMemory === "number" && signals.deviceMemory <= MOBILE_MAX_DEVICE_MEMORY_GB;
  const fewCores =
    typeof signals.hardwareConcurrency === "number" &&
    signals.hardwareConcurrency <= MOBILE_MAX_HARDWARE_CONCURRENCY;
  return weakMemory || fewCores ? "mobile" : DETECTED_FALLBACK_PROFILE;
}

/** `navigator` fields the heuristic reads (minimal structural type). */
export interface NavigatorLike {
  maxTouchPoints?: number;
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

/**
 * Read the signals off a `navigator` object. Returns zeros /
 * `undefined` when the environment exposes none (Node, old
 * browsers), which the heuristic reads as "desktop".
 */
export function readDeviceSignals(nav?: NavigatorLike): DeviceSignals {
  const source =
    nav ?? (typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike));
  if (source === undefined) return { maxTouchPoints: 0 };
  return {
    maxTouchPoints: source.maxTouchPoints ?? 0,
    deviceMemory: source.deviceMemory,
    hardwareConcurrency: source.hardwareConcurrency,
  };
}

/** The kind a non-mobile device gets. */
export const DETECTED_FALLBACK_PROFILE: DetectedProfile = "desktop";

/**
 * The profile id actually in force: the override when it is a
 * concrete one, the detection otherwise. `desktop` deliberately
 * resolves to the *quality preset's* profile (so a player who
 * forces Desktop keeps their `low` preset), while `mobile` always
 * resolves to the phone floor.
 */
export function resolveProfileId(
  deviceProfile: DeviceProfile,
  signals: DeviceSignals,
  quality: QualityPreset = "high",
): PerfProfileId {
  if (deviceProfile === "mobile") return "mobile";
  if (deviceProfile === "desktop") return perfProfileFor(quality).id;
  const detected = detectProfile(signals);
  return detected === "mobile" ? "mobile" : perfProfileFor(quality).id;
}

/**
 * The effective {@link PerfProfile} for a settings snapshot —
 * the single call site the client uses (world load + the settings
 * bridge).
 */
export function profileForSettings(settings: Settings, signals: DeviceSignals): PerfProfile {
  return PERF_PROFILES[resolveProfileId(settings.deviceProfile, signals, settings.quality)];
}
