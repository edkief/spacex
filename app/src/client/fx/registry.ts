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

import { fxCapFor, perfProfileFor, type CappedFxKind, type PerfProfile } from "@shared/perf.js";
import { settingsStore } from "../a11y/settings.js";
import { settingsBridge } from "../world/settingsBridge.js";

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
  /** TASK-58: live effect ids per capped kind, oldest first. The
   *  cap is enforced by evicting the oldest entry when a spawn
   *  would exceed the profile's budget. */
  private readonly live: Record<CappedFxKind, number[]> = {
    "laser-flash": [],
    "missile-tracer": [],
    debris: [],
  };
  /** TASK-58: the profile whose caps apply. Follows the settings
   *  bridge by default; tests inject a profile. */
  private profile: PerfProfile = perfProfileFor(settingsBridge.quality());

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

  /**
   * TASK-55: the preset's FX spawn-rate multiplier (1.0 / 0.6 /
   * 0.3). Cosmetic callers scale their particle / effect counts by
   * this so a `low` preset really does spawn a third of the FX.
   * Read per call — the preset may change mid-session.
   */
  fxScale(): number {
    return settingsBridge.current().fxQuality;
  }

  /**
   * Apply the FX multiplier to a desired effect count — e.g. a
   * debris burst of 10 spawns `ceil(10 * fxScale())` pieces (never
   * fewer than 1 while FX are enabled, so an effect never silently
   * disappears).
   */
  scaledCount(count: number): number {
    if (count <= 0) return 0;
    return Math.max(1, Math.round(count * this.fxScale()));
  }

  /**
   * Spawn a capped effect (laser flash, missile tracer, debris
   * set), enforcing the profile's concurrency cap.
   *
   * When the cap is reached the **oldest** live effect of that kind
   * expires and is replaced by the new spawn — the acceptance
   * criteria's "oldest expires" rule. Returns the id the caller
   * should render, or `null` when the effect was refused outright
   * (reduced motion on, or an unknown kind).
   *
   * @param kind — the capped effect kind.
   * @param id — caller-supplied effect id (usually a wire event id);
   *             defaults to a monotonic counter when omitted.
   */
  spawn(kind: CappedFxKind, id?: number): number | null {
    if (!this.allow(kind as FxKind)) return null;
    const live = this.live[kind];
    const cap = fxCapFor(kind, this.profile);
    if (live.length >= cap) live.shift();
    const next = id ?? this.nextId++;
    live.push(next);
    return next;
  }

  /** Live effect count for a capped kind (≤ its profile cap). */
  activeCount(kind: CappedFxKind): number {
    return this.live[kind].length;
  }

  /** The cap currently in force for a capped kind. */
  capFor(kind: CappedFxKind): number {
    return fxCapFor(kind, this.profile);
  }

  /** Swap the perf profile (TASK-58 tuning / TASK-59 mobile). */
  setProfile(profile: PerfProfile): void {
    this.profile = profile;
    for (const kind of Object.keys(this.live) as CappedFxKind[]) {
      const cap = fxCapFor(kind, profile);
      if (this.live[kind].length > cap) {
        this.live[kind].splice(0, this.live[kind].length - cap);
      }
    }
  }

  /** The profile whose caps are in force. */
  currentProfile(): PerfProfile {
    return this.profile;
  }

  /** Drop every live effect (level change / respawn). */
  clearLive(): void {
    for (const kind of Object.keys(this.live) as CappedFxKind[]) this.live[kind].length = 0;
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
    this.clearLive();
    this.profile = perfProfileFor(settingsBridge.quality());
  }

  /** Monotonic id source for `spawn()` when the caller passes none. */
  private nextId = 1;
}

/** The process-wide registry (the app + the FX components share it). */
export const fxRegistry = new FxRegistry();

/**
 * Connect the registry to the settings bridge (TASK-58): a quality
 * preset change re-caps the live FX immediately. The listener only
 * runs on an actual preset change, so the per-frame path stays a
 * plain `capFor()` lookup.
 */
settingsBridge.subscribe(() => {
  fxRegistry.setProfile(perfProfileFor(settingsBridge.quality()));
});
