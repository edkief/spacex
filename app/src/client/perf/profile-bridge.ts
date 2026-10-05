/**
 * TASK-58: the SettingsBridge for the tuning table (@shared/perf).
 *
 * A preset switch (or the boot fetch of the restored settings row) applies
 * the ACTIVE profile's tunables to the live pipeline WITHOUT re-init:
 *
 * - FX caps → every registered CombatFx instance (setFxCaps);
 * - the label cap → the remote-entity label layer (setLabelCap).
 *
 * The LOD radii / star count / fxQuality half of the bridge is the existing
 * TASK-55 wiring (chunks.setLodRadii, WorldManager's starCount, fx.ts'
 * fxSpawnRate) — this file only carries the TASK-58 additions.
 */
import type { QualityPreset } from '@shared/settings';
import { perfProfileFor, type FxCaps } from '@shared/perf';
import { setLabelCap } from '@client/world/remote-entities';

/** A sink for the profile's FX caps (the CombatFx registry). */
export interface FxCapSink {
  setFxCaps(caps: FxCaps): void;
}

const fxSinks = new Set<FxCapSink>();

/** Register an FX sink; returns the unregister (world swaps re-register). */
export function registerFxCapSink(sink: FxCapSink): () => void {
  fxSinks.add(sink);
  return () => {
    fxSinks.delete(sink);
  };
}

/**
 * Apply the active profile for a preset to the live pipeline (idempotent —
 * called on every settings commit, cheap no-op work when unchanged).
 */
export function applyPerfProfile(preset: QualityPreset): void {
  const profile = perfProfileFor(preset);
  for (const sink of fxSinks) sink.setFxCaps(profile.fxCaps);
  setLabelCap(profile.maxLabels);
}

/** Test hook: clear the sink registry (the label cap is left as-is). */
export function __resetPerfBridge(): void {
  fxSinks.clear();
}
