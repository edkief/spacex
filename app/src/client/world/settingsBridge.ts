/**
 * Settings bridge — TASK-55 (live pipeline re-tuning).
 *
 * A **mutable ref** between the settings store (UI / session load)
 * and the render pipeline. The chunk pipeline reads
 * {@link SettingsBridge.current} on *every* tick and *every* chunk
 * generation, so a preset change re-tunes the pipeline without a
 * re-init: no reload, no pop. Chunks already in the LRU keep the LOD
 * they were generated with; the next regeneration (or the LOD
 * recompute on the next tick) uses the new params.
 *
 * The bridge is deliberately not a React store — the FX registry and
 * the chunk pipeline read it from the render loop without importing
 * React.
 *
 * @see ./settingsBridge.test.ts
 */
import {
  DEFAULT_SETTINGS,
  type PipelineParams,
  type QualityPreset,
  type Settings,
} from "@shared/settings.js";
import {
  profileForSettings,
  readDeviceSignals,
  type DeviceSignals,
} from "@shared/deviceProfile.js";
import { DEFAULT_PERF_PROFILE, pipelineParamsForProfile, type PerfProfile } from "@shared/perf.js";
import { settingsStore, type SettingsStore } from "../a11y/settings.js";

/** Listener fired when the preset (and therefore the params) change. */
export type ParamsListener = (params: PipelineParams, prev: PipelineParams) => void;

/** Options for {@link SettingsBridge}. */
export interface SettingsBridgeOptions {
  /** Device signals used by the TASK-59 detection heuristic. */
  readonly signals?: DeviceSignals;
}

/** The bridge — one instance per client session. */
export class SettingsBridge {
  private params: PipelineParams = pipelineParamsForProfile(DEFAULT_PERF_PROFILE);
  private activeProfile: PerfProfile = DEFAULT_PERF_PROFILE;
  private activeQuality: QualityPreset = DEFAULT_SETTINGS.quality;
  private signals: DeviceSignals;
  private readonly listeners = new Set<ParamsListener>();

  constructor(options: SettingsBridgeOptions = {}) {
    this.signals = options.signals ?? readDeviceSignals();
  }

  /** The pipeline params in force right now. */
  current(): PipelineParams {
    return this.params;
  }

  /** The preset id backing {@link current}. */
  quality(): QualityPreset {
    return this.activeQuality;
  }

  /**
   * The perf profile in force (TASK-59). This is the *effective*
   * profile: the `mobile` floor when the device heuristic (or the
   * player's override) selects it, otherwise the quality preset's
   * own profile. The FX registry reads its caps from here.
   */
  profile(): PerfProfile {
    return this.activeProfile;
  }

  /** The device signals the profile heuristic reads (test seam). */
  deviceSignals(): DeviceSignals {
    return this.signals;
  }

  /** Replace the device signals and re-resolve the profile. */
  setSignals(signals: DeviceSignals): void {
    this.signals = signals;
    this.apply(settingsStore.getSnapshot());
  }

  /**
   * Re-tune from a settings snapshot. Idempotent: applying the same
   * preset twice notifies nobody (the panels call this on every
   * render).
   */
  apply(settings: Settings): void {
    const profile = profileForSettings(settings, this.signals);
    const next = pipelineParamsForProfile(profile);
    if (next === this.params) return;
    const prev = this.params;
    this.params = next;
    this.activeProfile = profile;
    this.activeQuality = settings.quality;
    for (const listener of [...this.listeners]) {
      try {
        listener(next, prev);
      } catch {
        // A faulty listener must not break the settings update.
      }
    }
  }

  /** Subscribe to preset changes. Returns the unsubscribe handle. */
  subscribe(listener: ParamsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** The process-wide bridge (client-only singleton). */
export const settingsBridge = new SettingsBridge();

/**
 * Keep the bridge in sync with the settings store. Idempotent — the
 * module connects once at import time (below) so the pipeline starts
 * from the persisted snapshot before the first frame renders, and
 * every later store write re-tunes the pipeline.
 */
export function connectSettingsBridge(store: SettingsStore = settingsStore): () => void {
  settingsBridge.apply(store.getSnapshot());
  return store.subscribe(() => {
    settingsBridge.apply(store.getSnapshot());
  });
}
/**
 * Connect on import: the settings store is the single owner of the
 * player's preferences, so the bridge follows it for the life of the
 * client session.
 */
connectSettingsBridge();
