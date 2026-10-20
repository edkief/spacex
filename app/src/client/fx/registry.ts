/**
 * FX registry — TASK-54 (reduced motion gate).
 *
 * Every cosmetic effect in the client registers here before it
 * renders. The registry is the single place that knows whether
 * motion is allowed:
 *
 *   - when **reduced motion is off** the effect plays and the
 *     `played` counter increments,
 *   - when **reduced motion is on** the effect is skipped, the
 *     `skipped` counter increments, and the caller renders
 *     nothing (or a static fallback).
 *
 * The counters are the test seam: the reduced-motion e2e asserts
 * `skipped > 0 && played === 0` after driving the FX paths.
 *
 * The registry is deliberately a plain class (no React) so the
 * non-React FX stores (weapon flashes, destruction explosions)
 * can consult it directly.
 *
 * @see ./registry.test.ts
 */

import { settingsStore } from "../a11y/settings.js";

/** The cosmetic effect kinds the registry gates. */
export type FxKind =
  | "laser-flash"
  | "missile-tracer"
  | "impact-flash"
  | "screen-shake"
  | "explosion"
  | "debris"
  | "smoke-trail"
  | "slow-mo"
  | "threat-ping"
  | "warp-streak";

/** Counters exposed for the tests / debug overlay. */
export interface FxCounters {
  /** Effects that were allowed to render. */
  played: number;
  /** Effects that were skipped because reduced motion is on. */
  skipped: number;
  /** Per-kind breakdown of the skips. */
  skippedByKind: Record<string, number>;
}

/**
 * The registry. One instance per client session; the app owns it
 * and passes it to the FX components.
 */
export class FxRegistry {
  private counters: FxCounters = { played: 0, skipped: 0, skippedByKind: {} };

  /**
   * Ask the registry whether an effect may play.
   *
   * Returns `true` when the effect should render (and counts it),
   * `false` when reduced motion is on (and counts the skip).
   */
  allow(kind: FxKind): boolean {
    if (settingsStore.getSnapshot().reducedMotion) {
      this.counters.skipped += 1;
      this.counters.skippedByKind[kind] = (this.counters.skippedByKind[kind] ?? 0) + 1;
      return false;
    }
    this.counters.played += 1;
    return true;
  }

  /** The live counters (a copy — the caller cannot mutate them). */
  snapshot(): FxCounters {
    return {
      played: this.counters.played,
      skipped: this.counters.skipped,
      skippedByKind: { ...this.counters.skippedByKind },
    };
  }

  /** Reset the counters (test seam). */
  reset(): void {
    this.counters = { played: 0, skipped: 0, skippedByKind: {} };
  }
}

/** The process-wide registry (the app + the FX components share it). */
export const fxRegistry = new FxRegistry();
