/**
 * Regime wiring (TASK-25.2) — the live client instance of the regime manager.
 *
 * Owns ONE RegimeTracker (local prediction + server authority) and ONE
 * ControlsRemapper (the active key scheme). Fed from the game session:
 *
 * - setSystem(seed, systemId): on every enter_system snapshot (boot, warp
 *   arrival, reconnect) — resets server authority and loads the regime
 *   planets for systemForId(seed, systemId) via systemRegimePlanets. The
 *   client's planet data leaves `heightAt` unset (flat ground) until
 *   TASK-26 streams terrain — which is why the surface sub-state is
 *   server-authoritative in the tracker.
 * - onSelfUpdate(entity, nowMs): on every self entity_update (10 Hz) —
 *   the optional `flightRegime` (FLIGHT_REGIMES wire field, NOT the
 *   sublight/cruise/warp/docked `regime`) is server authority; a missing
 *   flightRegime (v1 back-compat) is "no authority update". The entity's
 *   last known flight state (pos, |vel|) is the local prediction stand-in
 *   until TASK-26 provides a per-frame local sim.
 *
 * RegimeTracker.onRegimeChange drives ControlsRemapper.setRegime, which
 * swaps the active key scheme instantly and logs the swap (debug).
 *
 * DOM-free and clock-free by design (timestamps are injected), so the whole
 * session wiring is unit-testable with a synthetic message stream.
 */

import { ControlsRemapper, type ControlsLogger } from '@client/input/controls';
import { systemForId } from '@shared/galaxy/system';
import {
  planetAtmosphereDensity,
  planetAtmosphereRadius,
  systemRegimePlanets,
} from '@shared/galaxy/planets';
import { boundaryFactor } from '@shared/physics/atmosphere';
import type { PlanetAtmo } from '@shared/physics/flight';
import { vecLength, type Vec3 } from '@shared/physics/vec';
import type { Planet } from '@shared/galaxy/types';
import type { EntityState } from '@shared/protocol/schemas';
import { RegimeTracker } from './regime';

export interface RegimeWiringOptions {
  /** Divergence-snap warning sink (defaults to console.warn; test injectable). */
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Controls-remap log sink (defaults to console.debug; test injectable). */
  log?: ControlsLogger;
}

export class RegimeWiring {
  private readonly tracker: RegimeTracker;
  /** The active control scheme owner (consumers: keyboard input, TASK-31). */
  readonly remapper: ControlsRemapper;
  /**
   * Full-Planet mirror of the current system (TASK-28.2). The RegimePlanet
   * list handed to the tracker carries only id/x/z/atmosphereRadius/landable
   * (no class/density), so the boundary math reads from the original
   * generated planets instead.
   */
  private systemPlanets: Planet[] = [];

  constructor(options: RegimeWiringOptions = {}) {
    this.remapper = new ControlsRemapper('space', options.log);
    this.tracker = new RegimeTracker({
      warn: options.warn,
      onRegimeChange: (regime) => {
        this.remapper.setRegime(regime);
      },
    });
  }

  /**
   * (Re)load the current system. Resets server authority (fresh system:
   * back to local prediction in space) and loads the regime planets.
   * Call on every system snapshot: first join, warp arrival, reconnect.
   */
  setSystem(seed: string, systemId: string): void {
    this.tracker.reset();
    const system = systemForId(seed, systemId);
    if (system) {
      this.tracker.setPlanets(systemRegimePlanets(system));
      this.systemPlanets = system.planets;
    } else {
      this.systemPlanets = [];
    }
  }

  /**
   * Feed one self entity_update into the tracker: the authoritative
   * flightRegime (when present), then the local prediction from the last
   * known flight state.
   */
  onSelfUpdate(entity: EntityState, nowMs: number): void {
    if (entity.flightRegime) this.tracker.applyServer(entity.flightRegime, undefined);
    this.tracker.updateLocal(entity.pos, vecLength(entity.vel), nowMs);
  }

  /** The regime the controls/rendering currently use (for future consumers). */
  get regime() {
    return this.tracker.regime;
  }

  /**
   * Atmosphere boundary factor at a position (TASK-28.2): 1 at the surface
   * → 0 at/above the enter radius of the tracked planet, 0 in space or when
   * no planet is tracked. The shared boundaryFactor keeps the tint exactly
   * on the same line as the drag ramp (COSMETIC only — never feeds physics).
   */
  atmosphereBoundaryAt(pos: Vec3): number {
    if (this.tracker.regime === 'space' || !this.tracker.planetId) return 0;
    const planet = this.systemPlanets.find((p) => p.id === this.tracker.planetId);
    return planet ? boundaryFactor(pos.y, { atmosphereRadius: planetAtmosphereRadius(planet) }) : 0;
  }

  /**
   * TASK-73: the atmosphere context the flight prediction needs — mirrors
   * the server's resolveRegimeCtx (density + enter radius from the SAME
   * generated Planet, so the client's integrateShip matches the authority).
   * Undefined in space, when no planet is tracked, or for airless bodies
   * (the server passes no planet context then either).
   */
  get planetAtmo(): PlanetAtmo | undefined {
    if (this.tracker.regime !== 'atmosphere' || !this.tracker.planetId) return undefined;
    const planet = this.systemPlanets.find((p) => p.id === this.tracker.planetId);
    return planet?.hasAtmosphere
      ? {
          atmosphereDensity: planetAtmosphereDensity(planet),
          atmosphereRadius: planetAtmosphereRadius(planet),
        }
      : undefined;
  }
}
