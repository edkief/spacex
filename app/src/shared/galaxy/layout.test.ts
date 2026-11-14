import { describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import {
  ATMOSPHERE_DENSITY,
  ATMOSPHERE_TOP_FRACTION,
  DOCK_ORBIT_FACTOR,
  INNERMOST_ORBIT_JITTER_M,
  INNERMOST_ORBIT_M,
  ORBIT_GAP_MAX_M,
  ORBIT_GAP_MIN_M,
  SIM_METRES_PER_KM,
  STAR_RADIUS_M,
} from '@shared/galaxy/layoutConfig.ts';

const SEED = 'drift-dev-seed-001';
const systems = generateStars(SEED).map((star) => generateSystemForStar(SEED, star));
const planets = systems.flatMap((system) => system.planets);
const norm = (p: { x: number; y: number; z: number }) =>
  Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  norm({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

describe('system layout', () => {
  it('uses 1:100 sim radii: landable planets 20-80 km, gas giants 200-600 km', () => {
    for (const planet of planets) {
      expect(planet.simRadius).toBe(planet.radiusKm * SIM_METRES_PER_KM);
      if (planet.class === 'gas') {
        expect(planet.simRadius).toBeGreaterThanOrEqual(200_000);
        expect(planet.simRadius).toBeLessThanOrEqual(600_000);
      } else {
        expect(planet.simRadius).toBeGreaterThanOrEqual(20_000);
        expect(planet.simRadius).toBeLessThanOrEqual(80_000);
      }
    }
  });

  it('puts planets in the y = 0 plane on increasing orbits with the specified spacing', () => {
    for (const system of systems) {
      let previous = 0;
      system.planets.forEach((planet, index) => {
        expect(planet.position.y).toBe(0);
        expect(Math.abs(norm(planet.position) - planet.orbitRadius)).toBeLessThan(0.01);
        if (index === 0) {
          expect(planet.orbitRadius).toBeGreaterThanOrEqual(INNERMOST_ORBIT_M);
          expect(planet.orbitRadius).toBeLessThanOrEqual(
            INNERMOST_ORBIT_M + INNERMOST_ORBIT_JITTER_M + 1,
          );
        } else {
          const gap = planet.orbitRadius - previous;
          expect(gap).toBeGreaterThanOrEqual(ORBIT_GAP_MIN_M - 1);
          expect(gap).toBeLessThanOrEqual(ORBIT_GAP_MAX_M + 1);
        }
        previous = planet.orbitRadius;
      });
    }
  });

  it('never lets bodies overlap: star and planets are far apart compared with their radii', () => {
    for (const system of systems) {
      const star = STAR_RADIUS_M[system.star.class];
      expect(system.star.radius).toBe(star);
      for (const planet of system.planets) {
        expect(planet.orbitRadius - planet.simRadius * DOCK_ORBIT_FACTOR).toBeGreaterThan(star);
      }
      for (let i = 0; i < system.planets.length; i++) {
        for (let j = i + 1; j < system.planets.length; j++) {
          const a = system.planets[i]!;
          const b = system.planets[j]!;
          expect(dist(a.position, b.position)).toBeGreaterThan(
            (a.simRadius + b.simRadius) * DOCK_ORBIT_FACTOR * 2,
          );
        }
      }
    }
  });

  it('gives each planet dockCount docks at 1.6 radii with unique ids and one pad each', () => {
    const ids = new Set<string>();
    for (const planet of planets) {
      expect(planet.docks).toHaveLength(planet.dockCount);
      for (const dock of planet.docks) {
        expect(
          Math.abs(dist(dock.position, planet.position) - planet.simRadius * DOCK_ORBIT_FACTOR),
        ).toBeLessThan(0.01);
        expect(dock.id).toMatch(/^[0-9a-f]{16}$/);
        expect(dock.padId).toMatch(/^[0-9a-f]{16}$/);
        ids.add(dock.id);
        ids.add(dock.padId);
      }
    }
    expect(ids.size).toBe(planets.reduce((sum, p) => sum + p.docks.length * 2, 0));
  });

  it('spreads a planet’s docks apart (at least ~26 degrees) in nearly every case', () => {
    let pairs = 0;
    let close = 0;
    for (const planet of planets) {
      for (let i = 0; i < planet.docks.length; i++) {
        for (let j = i + 1; j < planet.docks.length; j++) {
          const a = planet.docks[i]!.position;
          const b = planet.docks[j]!.position;
          const r = planet.simRadius * DOCK_ORBIT_FACTOR;
          const dot =
            ((a.x - planet.position.x) * (b.x - planet.position.x) +
              (a.y - planet.position.y) * (b.y - planet.position.y) +
              (a.z - planet.position.z) * (b.z - planet.position.z)) /
            (r * r);
          pairs++;
          if (dot > 0.9 + 1e-6) close++;
        }
      }
    }
    expect(pairs).toBeGreaterThan(50);
    expect(close).toBe(0);
  });

  it('adds atmosphere parameters only where hasAtmosphere, from the per-class table', () => {
    for (const planet of planets) {
      if (!planet.hasAtmosphere) expect(planet.atmosphere).toBeNull();
      else
        expect(planet.atmosphere).toEqual({
          density: ATMOSPHERE_DENSITY[planet.class],
          topFraction: ATMOSPHERE_TOP_FRACTION,
        });
    }
    expect(ATMOSPHERE_TOP_FRACTION).toBeCloseTo(0.12);
  });

  it('is deterministic and independent of the fields generated before it', () => {
    const again = generateSystemForStar(SEED, generateStars(SEED)[7]!);
    expect(again).toEqual(systems[7]);
  });
});
