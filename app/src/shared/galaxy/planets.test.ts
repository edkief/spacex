import { describe, expect, it } from 'vitest';

import { ATMOSPHERE_BOUNDARY_M, hazeFactor } from '../physics/atmosphere';
import {
  PLANET_SURFACE_RADIUS_M,
  planetAnchor,
  planetAtmosphereDensity,
  planetAtmosphereRadius,
  systemRegimePlanets,
} from './planets';
import { DEPOSIT_SCATTER_RADIUS_M } from '../world/deposits';
import { HAZARD_SCATTER_RADIUS_M } from '../world/hazards';
import { generateStars } from './stars';
import { generateSystem } from './system';
import type { Planet, SystemGen } from './types';

const airless: Planet = {
  id: 'p1',
  name: 'A',
  class: 'rocky',
  radiusKm: 1000,
  hasAtmosphere: false,
  landable: true,
  dockCount: 1,
  resourceTypes: ['iron'],
  aiRoster: { count: 2, classes: ['scout', 'scout'] },
};
const terran: Planet = { ...airless, id: 'p2', hasAtmosphere: true, landable: true };
const gas: Planet = { ...airless, id: 'p3', class: 'gas', hasAtmosphere: true, landable: false };

describe('planetAtmosphereRadius (TASK-4 data → regime boundary)', () => {
  it('airless planets get 0 (space only)', () => {
    expect(planetAtmosphereRadius(airless)).toBe(0);
  });

  it('atmospheric planets get the shared 1 km TASK-22 drag boundary', () => {
    expect(planetAtmosphereRadius(terran)).toBe(ATMOSPHERE_BOUNDARY_M);
    expect(planetAtmosphereRadius(gas)).toBe(ATMOSPHERE_BOUNDARY_M);
  });
});

describe('planetAtmosphereDensity (TASK-28 per-planet haze + drag density)', () => {
  it('airless planets have density 0', () => {
    expect(planetAtmosphereDensity(airless)).toBe(0);
  });

  it('is deterministic and positive for atmospheric planets', () => {
    expect(planetAtmosphereDensity(terran)).toBeGreaterThan(0);
    expect(planetAtmosphereDensity(terran)).toBe(planetAtmosphereDensity(terran));
  });

  it('two planets of the seeded galaxy differ by > 20% haze at mid-boundary', () => {
    // The render test's pure-math counterpart: a seeded system with two or
    // more atmospheric planets shows a visible haze difference at the
    // boundary mid-band (thin-atmosphere planets are visibly less hazy).
    const star = generateStars('DRIFT-SEED-0001')[0];
    const system = generateSystem('DRIFT-SEED-0001', star.id);
    const atmospheric = system.planets.filter((p) => p.hasAtmosphere);
    expect(atmospheric.length).toBeGreaterThanOrEqual(2);
    const hazeAt = (p: Planet): number =>
      hazeFactor(ATMOSPHERE_BOUNDARY_M / 2, {
        atmosphereRadius: planetAtmosphereRadius(p),
        atmosphereDensity: planetAtmosphereDensity(p),
      });
    let maxDiff = 0;
    for (const a of atmospheric) {
      for (const b of atmospheric) {
        if (a.id === b.id) continue;
        const hA = hazeAt(a);
        const hB = hazeAt(b);
        maxDiff = Math.max(maxDiff, Math.abs(hA - hB) / Math.max(hA, hB));
      }
    }
    expect(maxDiff).toBeGreaterThan(0.2);
  });
});

describe('planetAnchor (deterministic sim placement)', () => {
  it('anchors are spaced PLANET_ANCHOR_SPACING_M apart along +X from the origin', () => {
    expect(planetAnchor(0)).toEqual({ x: 10_000, z: 0 });
    expect(planetAnchor(1)).toEqual({ x: 20_000, z: 0 });
    expect(planetAnchor(2).x - planetAnchor(1).x).toBe(10_000);
  });
});

describe('systemRegimePlanets (regime view of a system)', () => {
  it('maps planets in orbital-slot order with anchor + radius + landable', () => {
    const system: SystemGen = {
      systemId: 'sys-1',
      name: 'X',
      star: { class: 'G', name: 'X' },
      planets: [airless, terran, gas],
    };
    const planets = systemRegimePlanets(system);
    expect(planets.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(planets[0]).toEqual({
      id: 'p1',
      x: 10_000,
      z: 0,
      atmosphereRadius: 0,
      landable: true,
    });
    expect(planets[1].atmosphereRadius).toBe(ATMOSPHERE_BOUNDARY_M);
    expect(planets[2]).toMatchObject({
      id: 'p3',
      atmosphereRadius: ATMOSPHERE_BOUNDARY_M,
      landable: false,
    });
  });

  it('is deterministic across invocations', () => {
    const system: SystemGen = {
      systemId: 'sys-1',
      name: 'X',
      star: { class: 'G', name: 'X' },
      planets: [airless, terran],
    };
    expect(systemRegimePlanets(system)).toEqual(systemRegimePlanets(system));
  });
});

describe('PLANET_SURFACE_RADIUS_M (TASK-83 shared surface extent)', () => {
  it('bounds the deposit + hazard scatter radii (nothing lands off the island)', () => {
    // The placement radii must stay within the rendered island radius — the
    // sim scatters surface content no farther than the client island.
    expect(DEPOSIT_SCATTER_RADIUS_M).toBeLessThanOrEqual(PLANET_SURFACE_RADIUS_M);
    expect(HAZARD_SCATTER_RADIUS_M).toBeLessThanOrEqual(PLANET_SURFACE_RADIUS_M);
    // They actually ARE the shared constant (one edit widens both + the island).
    expect(DEPOSIT_SCATTER_RADIUS_M).toBe(PLANET_SURFACE_RADIUS_M);
    expect(HAZARD_SCATTER_RADIUS_M).toBe(PLANET_SURFACE_RADIUS_M);
  });
});
