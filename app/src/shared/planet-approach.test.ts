import { describe, expect, it } from 'vitest';

import { ATMOSPHERE_BOUNDARY_M } from './physics/atmosphere';
import {
  VTOL_HORIZONAL_LIMIT,
  integrateShip,
  type PlanetAtmo,
  type ShipInput,
} from './physics/flight';
import { vecLength } from './physics/vec';
import { regimeFor, type Regime, type RegimePlanet } from './regime';

/**
 * TASK-87 contract: a ship flying a STRAIGHT LINE from space to a planet's
 * surface at a reasonable approach speed must transition
 * space → atmosphere → surface and NEVER end up inside the planet body
 * (below the terrain). The repro is the owner-reported "hold W at the planet"
 * — no retro-burn, no scripted slow-down: the ship just goes in at speed and
 * must end ON the surface.
 *
 * This drives the SAME two shared pieces the server tick uses (regimeFor then
 * integrateShip, in that order) over a FLAT-terrain landable planet, so it is
 * the deterministic contract both the server and the client predictor must
 * meet. The ATMOSPHERIC approaches already land (drag slows the ship); the
 * AIRLESS approaches are the owner-reported bug — pre-fix the regime stayed
 * 'space' forever and the flight model applied no ground collision in space,
 * so the ship tunneled through the planet body. The airless tests FAIL
 * without the TASK-87 fix (regime surface disc + space ground collision +
 * friction) and pass with it.
 */

const DT = 0.05; // the server's fixed 20 Hz tick
const ANCHOR_X = 10_000;
const ANCHOR_Z = 0;
const ATM_R = ATMOSPHERE_BOUNDARY_M; // 1000

const NO_INPUT: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };

/** A flat-terrain landable atmospheric planet at the canonical first anchor. */
const PLANET: RegimePlanet = {
  id: 'planet-0',
  x: ANCHOR_X,
  z: ANCHOR_Z,
  atmosphereRadius: ATM_R,
  landable: true,
  heightAt: () => 0,
};
const ATMO: PlanetAtmo = { atmosphereDensity: 0.08, atmosphereRadius: ATM_R };

interface ApproachResult {
  /** Initial regime + one entry per transition (the wire sequence). */
  sequence: Regime[];
  /** The lowest terrain-relative altitude the ship ever reached (u). */
  minAltitude: number;
  /** Final regime + speed (u/s). */
  endRegime: Regime;
  endSpeed: number;
}

/**
 * Drive the shared tick (regimeFor → integrateShip) until the ship lands
 * (surface + slow) or the tick budget runs out. Mirrors the server's per-tick
 * order exactly: the regime is resolved FIRST (with the current speed), then
 * the ship is integrated with the resolved regime (atmosphere/surface get the
 * planet context, space gets none — as the server's resolveRegimeCtx wires).
 */
function runApproach(startX: number, startY: number, approachSpeed: number, ticks = 6000): ApproachResult {
  const sequence: Regime[] = ['space'];
  let regime: Regime = 'space';
  let pos = { x: startX, y: startY, z: ANCHOR_Z };
  let vel = { x: -approachSpeed, y: 0, z: 0 };
  let quat = { x: 0, y: 0, z: 0, w: 1 };
  let minAltitude = Infinity;
  let speed = approachSpeed;

  for (let i = 0; i < ticks; i++) {
    const resolved = regimeFor(pos, [PLANET], regime, speed);
    if (resolved.regime !== regime) {
      regime = resolved.regime;
      sequence.push(regime);
    }
    const next = integrateShip(
      { pos, vel, quat, regime },
      NO_INPUT,
      DT,
      regime,
      regime === 'space' ? undefined : ATMO,
      'scout',
      { heightAt: (x, z) => PLANET.heightAt!(x, z) },
    );
    pos = next.pos;
    vel = next.vel;
    quat = next.quat;
    speed = vecLength(vel);
    const altitude = pos.y - PLANET.heightAt!(pos.x, pos.z);
    if (altitude < minAltitude) minAltitude = altitude;
    // Landed: on the surface and slow (the regime machine's own thresholds).
    if (regime === 'surface' && speed <= 1e-6) break;
  }
  return { sequence, minAltitude, endRegime: regime, endSpeed: speed };
}

describe('TASK-87 planet approach: space → surface, no tunnel-through', () => {
  it('a straight 120 u/s approach transitions space → atmosphere → surface', () => {
    const r = runApproach(ANCHOR_X + 3000, 0, 120);
    expect(r.sequence).toEqual(['space', 'atmosphere', 'surface']);
    expect(r.endRegime).toBe('surface');
  });

  it('the ship is never below the terrain (never inside the planet body)', () => {
    const r = runApproach(ANCHOR_X + 3000, 0, 120);
    // A small negative tolerance absorbs float noise; the ground clamp keeps
    // the ship AT the terrain in atmosphere/surface, and the ship approaches
    // from above in space, so it must never sink below the surface.
    expect(r.minAltitude).toBeGreaterThanOrEqual(-0.5);
  });

  it('the approach ends ON the surface at rest (speed below the landing limit)', () => {
    const r = runApproach(ANCHOR_X + 3000, 0, 120);
    expect(r.endRegime).toBe('surface');
    expect(r.endSpeed).toBeLessThanOrEqual(VTOL_HORIZONAL_LIMIT + 1e-6);
  });

  it('a faster (cruise, 480 u/s) approach also lands, never tunneling', () => {
    const r = runApproach(ANCHOR_X + 4000, 0, 480);
    expect(r.sequence).toEqual(['space', 'atmosphere', 'surface']);
    expect(r.minAltitude).toBeGreaterThanOrEqual(-0.5);
    expect(r.endSpeed).toBeLessThanOrEqual(VTOL_HORIZONAL_LIMIT + 1e-6);
  });

  it('a slow (surface-eligible) approach lands dead-stick, no impact', () => {
    // Below the landing limit the whole way: the ship enters the atmosphere
    // already slow (start 1100 u out → 100 u of coast to the boundary) and
    // the regime machine resolves 'surface' at the terrain.
    const r = runApproach(ANCHOR_X + 1100, 0, 4, 2000);
    expect(r.sequence).toEqual(['space', 'atmosphere', 'surface']);
    expect(r.minAltitude).toBeGreaterThanOrEqual(-0.5);
  });

  describe('AIRLESS planet (atmosphereRadius 0) — the owner-reported tunnel', () => {
    /** A flat-terrain landable AIRLESS planet at the canonical first anchor. */
    const AIRLESS: RegimePlanet = {
      id: 'planet-airless',
      x: ANCHOR_X,
      z: ANCHOR_Z,
      atmosphereRadius: 0,
      landable: true,
      heightAt: () => 0,
    };
    const DISC = { x: ANCHOR_X, z: ANCHOR_Z, radius: 2_000, planetId: 'planet-airless' };

    /**
     * Drive the shared tick over the airless planet, wiring the solid-surface
     * context exactly as the server's resolveRegimeCtx does: no atmosphere
     * (density 0) and the surfaceDisc so the flight model's ground collision
     * + friction engage.
     */
    function runAirlessApproach(startX: number, approachSpeed: number, ticks = 6000): ApproachResult {
      const sequence: Regime[] = ['space'];
      let regime: Regime = 'space';
      let pos = { x: startX, y: 0, z: ANCHOR_Z };
      let vel = { x: -approachSpeed, y: 0, z: 0 };
      let quat = { x: 0, y: 0, z: 0, w: 1 };
      let minAltitude = Infinity;
      let speed = approachSpeed;

      for (let i = 0; i < ticks; i++) {
        const resolved = regimeFor(pos, [AIRLESS], regime, speed);
        if (resolved.regime !== regime) {
          regime = resolved.regime;
          sequence.push(regime);
        }
        const next = integrateShip(
          { pos, vel, quat, regime },
          NO_INPUT,
          DT,
          regime,
          undefined, // airless: no atmosphere / drag
          'scout',
          { heightAt: () => 0, surfaceDisc: DISC },
        );
        pos = next.pos;
        vel = next.vel;
        quat = next.quat;
        speed = vecLength(vel);
        const altitude = pos.y - AIRLESS.heightAt!(pos.x, pos.z);
        if (altitude < minAltitude) minAltitude = altitude;
        if (regime === 'surface' && speed <= 1e-6) break;
      }
      return { sequence, minAltitude, endRegime: regime, endSpeed: speed };
    }

    it('a straight 120 u/s approach lands (space → surface), never tunneling', () => {
      // Starts 2 500 u out: 500 u of open space, then the solid 2 km disc.
      const r = runAirlessApproach(ANCHOR_X + 2_500, 120);
      expect(r.sequence).toEqual(['space', 'surface']);
      expect(r.endRegime).toBe('surface');
      expect(r.minAltitude).toBeGreaterThanOrEqual(-0.5);
      expect(r.endSpeed).toBeLessThanOrEqual(VTOL_HORIZONAL_LIMIT + 1e-6);
    });

    it('a cruise-speed (480 u/s) approach lands, never tunneling', () => {
      const r = runAirlessApproach(ANCHOR_X + 3_000, 480);
      expect(r.sequence).toEqual(['space', 'surface']);
      expect(r.minAltitude).toBeGreaterThanOrEqual(-0.5);
      expect(r.endSpeed).toBeLessThanOrEqual(VTOL_HORIZONAL_LIMIT + 1e-6);
    });

    it('the ship stays on the ground once landed (friction stops it fully)', () => {
      const r = runAirlessApproach(ANCHOR_X + 2_500, 120);
      expect(r.endSpeed).toBeLessThanOrEqual(1e-6);
    });
  });
});
