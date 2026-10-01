/**
 * Client regime tracking (TASK-25) — local prediction + server authority.
 *
 * The server sends the flight regime in every entity_update (authoritative).
 * The client's local `regimeFor` (the SAME shared function the sim uses —
 * same planet data, same seed) is PREDICTION ONLY: it keeps controls and
 * rendering on the right scheme between snapshots. If local and server
 * disagree for more than REGIME_DIVERGENCE_MS (500 ms) the client SNAPS to
 * the server regime with a debug warning — divergence past the tolerance
 * means a bug (the local planet data must be identical), not latency.
 *
 * Surface is an exception: the client has no terrain yet (flat ground), so
 * any local↔server disagreement INVOLVING 'surface' is expected, not a bug —
 * the active regime follows the server immediately with no clock/snap/warn.
 * The 500 ms divergence rule remains for space/atmosphere only.
 *
 * No wall clock by default: `now` is injectable, so the 500 ms rule is
 * unit-testable with fake timestamps (the divergence test).
 */

import { regimeFor, type Regime, type RegimePlanet } from '@shared/regime';
import type { Vec3 } from '@shared/physics/vec';

/** Max tolerated local/server divergence before the client snaps (ms). */
export const REGIME_DIVERGENCE_MS = 500;

export interface RegimeTrackerOptions {
  /** Warning sink for divergence snaps (injectable in tests). */
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Called when the ACTIVE regime changes (drives the controls remap). */
  onRegimeChange?: (regime: Regime, planetId: string | undefined) => void;
}

export class RegimeTracker {
  private planets: RegimePlanet[] = [];
  private local: Regime = 'space';
  private localPlanetId: string | undefined;
  private serverRegime: Regime | null = null;
  private serverPlanetId: string | undefined;
  /** When the current local/server disagreement started (null = in agreement). */
  private divergingSince: number | null = null;
  private active: Regime = 'space';
  private activePlanetId: string | undefined;
  private readonly warn: (msg: string, meta?: Record<string, unknown>) => void;
  private readonly onChange: RegimeTrackerOptions['onRegimeChange'];

  constructor(options: RegimeTrackerOptions = {}) {
    this.warn = options.warn ?? ((msg, meta) => console.warn(`[regime] ${msg}`, meta ?? ''));
    this.onChange = options.onRegimeChange;
  }

  /** The system's planets (shared derivation; identical on client + server). */
  setPlanets(planets: RegimePlanet[]): void {
    this.planets = planets;
  }

  /** Reset on system change (warp / rejoin): no server authority yet. */
  reset(): void {
    this.local = 'space';
    this.localPlanetId = undefined;
    this.serverRegime = null;
    this.serverPlanetId = undefined;
    this.divergingSince = null;
    if (this.active !== 'space') {
      this.active = 'space';
      this.activePlanetId = undefined;
      this.onChange?.(this.active, this.activePlanetId);
    }
  }

  /**
   * Per-frame local prediction from the predicted ship state. Returns the
   * active regime. Handles the divergence clock: if local and server have
   * disagreed for more than REGIME_DIVERGENCE_MS, snap to the server
   * regime (with a debug warning).
   */
  updateLocal(pos: Vec3, speed: number, nowMs: number): Regime {
    const result = regimeFor(pos, this.planets, this.local, speed);
    this.local = result.regime;
    this.localPlanetId = result.planetId;

    if (this.serverRegime === null) {
      // No server authority yet: local prediction is active.
      this.setActive(this.local, this.localPlanetId);
      return this.active;
    }

    if (this.local === this.serverRegime) {
      this.divergingSince = null; // back in agreement
      this.setActive(this.local, this.localPlanetId);
    } else if (this.local === 'surface' || this.serverRegime === 'surface') {
      // Surface is server-authoritative: the client has no terrain yet
      // (systemRegimePlanets leaves heightAt unset → flat ground), so any
      // disagreement INVOLVING 'surface' is expected around landings on real
      // relief. Follow the server immediately — no divergence clock, no snap,
      // no warning. (Space/atmosphere data is identical same-seed, so a
      // disagreement there stays a bug: the 500 ms rule below still applies.)
      this.divergingSince = null;
      this.setActive(this.serverRegime, this.serverPlanetId);
    } else {
      this.divergingSince ??= nowMs;
      if (nowMs - this.divergingSince >= REGIME_DIVERGENCE_MS) {
        // Tolerance exceeded: snap to the server (authority) + warn.
        this.warn('regime divergence > 500 ms — snapped to server', {
          local: this.local,
          server: this.serverRegime,
          localPlanetId: this.localPlanetId ?? null,
          serverPlanetId: this.serverPlanetId ?? null,
        });
        this.local = this.serverRegime;
        this.localPlanetId = this.serverPlanetId;
        this.divergingSince = null;
        this.setActive(this.serverRegime, this.serverPlanetId);
      }
      // Under the tolerance: prediction stays active (controls stay local).
    }
    return this.active;
  }

  /** Authoritative server regime from an entity_update (the server wins). */
  applyServer(regime: Regime, planetId: string | undefined): void {
    this.serverRegime = regime;
    this.serverPlanetId = planetId;
  }

  /** The regime the controls/rendering currently use. */
  get regime(): Regime {
    return this.active;
  }

  /** The owning planet of the active regime (undefined in space). */
  get planetId(): string | undefined {
    return this.activePlanetId;
  }

  /** ms of current local/server disagreement (null = in agreement/no server). */
  divergenceMs(nowMs: number): number | null {
    return this.divergingSince === null ? null : nowMs - this.divergingSince;
  }

  private setActive(regime: Regime, planetId: string | undefined): void {
    if (regime === this.active && planetId === this.activePlanetId) return;
    this.active = regime;
    this.activePlanetId = planetId;
    this.onChange?.(this.active, this.activePlanetId);
  }
}
