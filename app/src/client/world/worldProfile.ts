/**
 * World profile application — TASK-59.
 *
 * The device profile is resolved by the settings bridge (the
 * override or the navigator heuristic), but the *pipeline re-init*
 * is deliberately **not live**: the mobile-tier cuts (chunk rings,
 * FX caps, star count, the flat haze, dot tracers) land on the next
 * world load. The warp transition is that path (TASK-8), so
 * {@link WorldProfileManager.loadWorld} is called on every world
 * swap and on the first load.
 *
 * When the profile id actually changed between two world loads the
 * manager returns {@link PROFILE_APPLIED_NOTICE} so the caller can
 * toast it — the spec's "Profile applied — re-entering system".
 *
 * @see ./worldProfile.test.ts
 */

import {
  PROFILE_APPLIED_NOTICE,
  profileForSettings,
  readDeviceSignals,
  type DeviceSignals,
} from "@shared/deviceProfile.js";
import type { PerfProfile, PerfProfileId } from "@shared/perf.js";
import type { Settings } from "@shared/settings.js";
import { settingsStore, type SettingsStore } from "../a11y/settings.js";
import { fxRegistry, type FxRegistry } from "../fx/registry.js";
import { settingsBridge, type SettingsBridge } from "./settingsBridge.js";

/** What a world load resolved to. */
export interface WorldProfileResult {
  /** The profile the world loaded with. */
  readonly profileId: PerfProfileId;
  /** True when the profile differs from the previous world load. */
  readonly changed: boolean;
  /** Toast text when the profile changed, `null` otherwise. */
  readonly notice: string | null;
  /** The profile object, for callers that need the numbers. */
  readonly profile: PerfProfile;
}

/** Injectable deps (the defaults are the process-wide singletons). */
export interface WorldProfileDeps {
  readonly store?: SettingsStore;
  readonly bridge?: SettingsBridge;
  readonly registry?: Pick<FxRegistry, "setProfile" | "clearLive">;
  readonly signals?: DeviceSignals;
}

/**
 * Applies the effective device profile to the render pipeline on
 * world load. One instance per client session; `App.tsx` owns it.
 */
export class WorldProfileManager {
  private readonly store: SettingsStore;
  private readonly bridge: SettingsBridge;
  private readonly registry: Pick<FxRegistry, "setProfile" | "clearLive">;
  private readonly signals: DeviceSignals;
  private lastLoaded: PerfProfileId | null = null;

  constructor(deps: WorldProfileDeps = {}) {
    this.store = deps.store ?? settingsStore;
    this.bridge = deps.bridge ?? settingsBridge;
    this.registry = deps.registry ?? fxRegistry;
    this.signals = deps.signals ?? this.bridge.deviceSignals() ?? readDeviceSignals();
  }

  /** The profile the *next* world load would use (no side effects). */
  preview(): PerfProfile {
    return profileForSettings(this.store.getSnapshot(), this.signals);
  }

  /**
   * Apply the profile for a world load. Pushes it into the settings
   * bridge (chunk stream + FX scales) and re-caps the FX registry
   * (the re-init), dropping live effects whose cap just changed.
   */
  loadWorld(): WorldProfileResult {
    const settings: Settings = this.store.getSnapshot();
    const profile = profileForSettings(settings, this.signals);
    this.bridge.apply(settings);
    this.registry.setProfile(profile);
    this.registry.clearLive();
    const changed = this.lastLoaded !== null && this.lastLoaded !== profile.id;
    this.lastLoaded = profile.id;
    return {
      profileId: profile.id,
      changed,
      notice: changed ? PROFILE_APPLIED_NOTICE : null,
      profile,
    };
  }
}

/** The process-wide manager (`App.tsx` calls it on world load). */
export const worldProfileManager = new WorldProfileManager();
