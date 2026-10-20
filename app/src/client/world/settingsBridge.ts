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
  pipelineParamsFor,
  QUALITY_PRESETS,
  type PipelineParams,
  type QualityPreset,
  type Settings,
} from "@shared/settings.js";
import { settingsStore, type SettingsStore } from "../a11y/settings.js";

/** Listener fired when the preset (and therefore the params) change. */
export type ParamsListener = (params: PipelineParams, prev: PipelineParams) => void;

/** The bridge — one instance per client session. */
export class SettingsBridge {
  private params: PipelineParams = QUALITY_PRESETS[DEFAULT_SETTINGS.quality];
  private readonly listeners = new Set<ParamsListener>();

  /** The pipeline params in force right now. */
  current(): PipelineParams {
    return this.params;
  }

  /** The preset id backing {@link current}. */
  quality(): QualityPreset {
    return (
      (Object.keys(QUALITY_PRESETS) as QualityPreset[]).find(
        (id) => QUALITY_PRESETS[id] === this.params,
      ) ?? DEFAULT_SETTINGS.quality
    );
  }

  /**
   * Re-tune from a settings snapshot. Idempotent: applying the same
   * preset twice notifies nobody (the panels call this on every
   * render).
   */
  apply(settings: Settings): void {
    const next = pipelineParamsFor(settings.quality);
    if (next === this.params) return;
    const prev = this.params;
    this.params = next;
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
