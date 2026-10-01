import { describe, expect, it } from 'vitest';

import { ATMOSPHERE_BOUNDARY_M } from '../physics/atmosphere';
import { planetAnchor, planetAtmosphereRadius, systemRegimePlanets } from './planets';
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
    expect(planets[2]).toMatchObject({ id: 'p3', atmosphereRadius: ATMOSPHERE_BOUNDARY_M, landable: false });
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
