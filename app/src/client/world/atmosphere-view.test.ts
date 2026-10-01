import { describe, expect, it } from 'vitest';

import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { planetAnchor, planetAtmosphereDensity } from '@shared/galaxy/planets';
import { densityScale } from '@shared/physics/atmosphere';
import { vec } from '@shared/physics/vec';

import { atmosphereViewFor } from './atmosphere-view';

const SEED = 'TEST-SEED-28-1';

/**
 * Deterministic fixture: the first star (in seeded order) whose system has
 * an atmosphere planet — the same fixture-system pattern as the regime
 * wiring tests (derive one system from generateStars, then generateSystem).
 */
function fixtureSystem(): { system: SystemGen; planet: Planet } {
  for (const star of generateStars(SEED)) {
    const system = generateSystem(SEED, star.id);
    const planet = system.planets.find((p) => p.hasAtmosphere);
    if (planet) return { system, planet };
  }
  throw new Error(`seed ${SEED} has no atmosphere planet`);
}

const FIXTURE = fixtureSystem();
const SYSTEM = FIXTURE.system;
const ATMO_PLANET = FIXTURE.planet;
/** Orbital-slot index of the fixture planet (anchors derive from it). */
const INDEX = SYSTEM.planets.indexOf(ATMO_PLANET);
const ANCHOR = planetAnchor(INDEX);

/** A position at the given altitude directly above the planet's anchor. */
function atAltitude(altitude: number): { x: number; y: number; z: number } {
  return vec(ANCHOR.x, altitude, ANCHOR.z);
}

/** A synthetic airless system (deterministic, no generation needed). */
const AIRLESS_SYSTEM: SystemGen = {
  systemId: 'dead-system',
  name: 'Dead system',
  star: { class: 'M', name: 'Dead' },
  planets: [
    {
      id: 'dead-1',
      name: 'Dead',
      class: 'rocky',
      radiusKm: 3_000,
      hasAtmosphere: false,
      landable: true,
      dockCount: 0,
      resourceTypes: [],
      aiRoster: { count: 0, classes: [] },
    },
  ],
};

describe('atmosphereViewFor (pure atmosphere resolution)', () => {
  it('mid-band altitude: boundary ≈ 0.5 and haze = 0.5 × densityScale of the SAME shared functions', () => {
    const view = atmosphereViewFor(atAltitude(500), SYSTEM, 'space');
    expect(view.planet?.id).toBe(ATMO_PLANET.id);
    expect(view.altitude).toBe(500);
    expect(view.boundary).toBeCloseTo(0.5, 10);
    // The haze must be exactly the shared function's output for the same
    // planet (not a re-derived or rounded number).
    const expectedHaze = 0.5 * densityScale(planetAtmosphereDensity(ATMO_PLANET));
    expect(view.haze).toBeCloseTo(expectedHaze, 10);
  });

  it('a far position (and a missing system) is space: planet null, boundary 0, haze 0', () => {
    const far = atmosphereViewFor(vec(1_000_000, 0, 1_000_000), SYSTEM, 'atmosphere');
    expect(far.planet).toBeNull();
    expect(far.boundary).toBe(0);
    expect(far.haze).toBe(0);

    const noSystem = atmosphereViewFor(atAltitude(500), null, 'atmosphere');
    expect(noSystem.planet).toBeNull();
    expect(noSystem.boundary).toBe(0);
    expect(noSystem.haze).toBe(0);
  });

  it('the exit hysteresis band [1000,1050) respects the passed current regime', () => {
    // 1025 u above the anchor: inside the 50 m exit band.
    const pos = atAltitude(1025);
    // History 'atmosphere' keeps the planet (no flap) …
    const held = atmosphereViewFor(pos, SYSTEM, 'atmosphere');
    expect(held.planet?.id).toBe(ATMO_PLANET.id);
    // … while history 'space' yields null at the same position.
    const dropped = atmosphereViewFor(pos, SYSTEM, 'space');
    expect(dropped.planet).toBeNull();
    expect(dropped.haze).toBe(0);
  });

  it('an airless planet yields space / null / 0', () => {
    // Directly above the airless anchor (index 0 → x = 10_000, z = 0), even
    // with an 'atmosphere' history — no atmosphere to keep.
    const view = atmosphereViewFor(vec(10_000, 500, 0), AIRLESS_SYSTEM, 'atmosphere');
    expect(view.planet).toBeNull();
    expect(view.boundary).toBe(0);
    expect(view.haze).toBe(0);
  });
});
