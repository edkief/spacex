/**
 * Regime manager (TASK-25) — the shared space/atmosphere/surface state
 * machine. The ship (or player) is always in exactly ONE regime; crossing a
 * boundary changes controls, physics context, and rendering with no cut,
 * load, or teleport.
 *
 * `regimeFor` is the single source of truth, used VERBATIM by:
 * - the server sim tick (authority — the resolved regime rides the wire in
 *   entity_update, shard.ts), and
 * - the client (prediction only — RegimeTracker snaps to the server regime
 *   after 500 ms of divergence).
 *
 * Geometry model (v1): each planet owns a region of the shared sim plane.
 * Its surface anchor (x, z) is where the local terrain plane touches the
 * atmosphere; the atmosphere is a sphere of radius `atmosphereRadius`
 * (u, 1 u ≈ 1 m) around that anchor. A ship is inside the atmosphere when
 * its 3D distance to the anchor is below the enter radius; it stays inside
 * until it climbs past the EXIT radius (enter × HYSTERESIS), so a ship
 * idling on the boundary never flaps (the 50 m band at the 1 km TASK-22
 * drag boundary). Surface is a sub-state of atmosphere: only reachable from
 * 'atmosphere' (never directly from 'space' — no space→surface transition),
 * with its own altitude hysteresis band.
 *
 * Pure and deterministic: same (pos, planets, current, speed) → identical
 * result. `planets[i].heightAt` is a caller-injected callback (the server
 * wires the chunk-cached TerrainContext; tests use analytic terrain) so this
 * module stays free of chunk generation.
 */

import { ATMOSPHERE_BOUNDARY_M } from './physics/atmosphere';
import type { Vec3 } from './physics/vec';

/** The three flight regimes (space ↔ atmosphere ↔ surface). */
export type Regime = 'space' | 'atmosphere' | 'surface';

/** Atmosphere exit radius = enter radius × this (anti-flap hysteresis). */
export const REGIME_EXIT_FACTOR = 1.05;
/** Altitude (u) below which a slow ship transitions atmosphere → surface. */
export const SURFACE_ENTER_ALT_M = 2;
/** Surface hysteresis band (u): surface ships stay surface up to enter+band. */
export const SURFACE_HYSTERESIS_M = 4;
/** Speed (u/s) at or below which a low ship counts as "slow" (surface-eligible). */
export const SURFACE_SPEED_LIMIT_M_S = 5;

/**
 * One planet as seen by the regime machine. `x`/`z` are the surface anchor
 * in shared sim coordinates (u); `heightAt` is the planet's terrain (u) —
 * defaults to flat ground at 0 when omitted.
 */
export interface RegimePlanet {
  id: string;
  x: number;
  z: number;
  /** Atmosphere radius around the anchor (u). 0 = airless (space only). */
  atmosphereRadius: number;
  /** Whether a ship may land on this planet (gas giants never). */
  landable: boolean;
  heightAt?: (x: number, z: number) => number;
}

/** The resolved regime plus the owning planet (undefined in space). */
export interface RegimeResult {
  regime: Regime;
  planetId?: string;
}

/**
 * Open-space clearance for cruise boost (TASK-85): the ship must be at
 * least this far outside EVERY atmosphere boundary before SHIFT raises its
 * top speed (landing zones and dogfights keep normal speeds).
 */
export const CRUISE_CLEARANCE_M = 1_500;

/**
 * Whether the space-cruise boost is ALLOWED at a position (TASK-85): true
 * when the 3D distance to every planet's anchor is at least its
 * atmosphere radius + {@link CRUISE_CLEARANCE_M}. Airless planets
 * (atmosphereRadius 0) still count at ATMOSPHERE_BOUNDARY_M — the same
 * boundary their domes/slabs are drawn at, so no one cruises into an
 * island. Pure and deterministic (server tick, client predictor and HUD
 * all call the same function); an empty planet list allows cruise.
 */
export function cruiseAllowedAt(pos: Vec3, planets: RegimePlanet[]): boolean {
  for (const p of planets) {
    const radius = p.atmosphereRadius > 0 ? p.atmosphereRadius : ATMOSPHERE_BOUNDARY_M;
    const clear = radius + CRUISE_CLEARANCE_M;
    if (anchorDistanceSquared(pos, p) < clear * clear) return false;
  }
  return true;
}

/** Squared 3D distance from pos to the planet's surface anchor. */
function anchorDistanceSquared(pos: Vec3, p: RegimePlanet): number {
  const dx = pos.x - p.x;
  const dy = pos.y; // anchors sit on the y = 0 surface plane
  const dz = pos.z - p.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Resolve the current regime for a position (TASK-25).
 *
 * Transition rules (the ONLY allowed transitions):
 * - space → atmosphere: distance to the nearest planet's anchor drops below
 *   its enter radius (atmosphereRadius);
 * - atmosphere → space: distance climbs to/over the exit radius
 *   (atmosphereRadius × REGIME_EXIT_FACTOR — the hysteresis band);
 * - atmosphere → surface: inside the atmosphere over a LANDABLE planet,
 *   altitude below terrain + SURFACE_ENTER_ALT_M while slow (≤ speed limit);
 * - surface → atmosphere: altitude above terrain + enter + SURFACE_HYSTERESIS_M,
 *   or speed above the limit.
 * No other transitions exist: 'space' can never resolve to 'surface' in one
 * step, airless planets (atmosphereRadius 0) stay space, and non-landable
 * planets never yield 'surface'.
 *
 * @param pos     world position (u)
 * @param planets the system's planets in regime form (nearest wins)
 * @param current the regime to resolve FROM (hysteresis anchor, default 'space')
 * @param speed   current speed (u/s); 0 = at rest
 */
export function regimeFor(
  pos: Vec3,
  planets: RegimePlanet[],
  current: Regime = 'space',
  speed = 0,
): RegimeResult {
  if (planets.length === 0) return { regime: 'space' };

  // Nearest planet by squared distance; ties break on id (deterministic).
  let nearest = planets[0];
  let nearestD2 = anchorDistanceSquared(pos, nearest);
  for (let i = 1; i < planets.length; i++) {
    const d2 = anchorDistanceSquared(pos, planets[i]);
    if (d2 < nearestD2 || (d2 === nearestD2 && planets[i].id < nearest.id)) {
      nearest = planets[i];
      nearestD2 = d2;
    }
  }
  if (nearest.atmosphereRadius <= 0) return { regime: 'space' };

  const d = Math.sqrt(nearestD2);
  const enterR = nearest.atmosphereRadius;
  const exitR = enterR * REGIME_EXIT_FACTOR;

  if (current === 'space') {
    // Space can only ever step into the atmosphere — never to surface.
    return d < enterR ? { regime: 'atmosphere', planetId: nearest.id } : { regime: 'space' };
  }

  // Hysteresis: leaving requires climbing to the EXIT radius; inside the
  // band [enterR, exitR) the current regime holds (no flapping).
  if (d >= exitR) return { regime: 'space' };

  if (!nearest.landable) return { regime: 'atmosphere', planetId: nearest.id };

  const alt = pos.y - (nearest.heightAt ? nearest.heightAt(pos.x, pos.z) : 0);
  const slow = speed <= SURFACE_SPEED_LIMIT_M_S;

  if (current === 'surface') {
    // Surface holds while low and slow; the band above enter altitude (or
    // being fast) returns the ship to the atmosphere.
    const stillSurface = alt <= SURFACE_ENTER_ALT_M + SURFACE_HYSTERESIS_M && slow;
    return stillSurface
      ? { regime: 'surface', planetId: nearest.id }
      : { regime: 'atmosphere', planetId: nearest.id };
  }

  // current === 'atmosphere'
  return alt < SURFACE_ENTER_ALT_M && slow
    ? { regime: 'surface', planetId: nearest.id }
    : { regime: 'atmosphere', planetId: nearest.id };
}
