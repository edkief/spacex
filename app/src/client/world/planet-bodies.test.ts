import { describe, expect, it } from 'vitest';

import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { ATMOSPHERE_BOUNDARY_M } from '@shared/physics/atmosphere';
import { vec } from '@shared/physics/vec';
import { PLANET_SURFACE_RADIUS_M, planetAnchor } from '@shared/galaxy/planets';
import { DOME_RADIUS_FACTOR } from '@client/render/atmosphere-dome';
import { PROXY_DISTANCE_M } from '@client/render/scaled-proxy';

import { buildPlanetBodies, setPlanetShellHidden, updatePlanetBodies } from './planet-bodies';

const SEED = 'TEST-SEED-83';

/** Deterministic fixture: the first star whose system has an atmosphere planet. */
function fixtureSystem() {
  for (const star of generateStars(SEED)) {
    const system = generateSystem(SEED, star.id);
    if (system.planets.some((p) => p.hasAtmosphere) && system.planets.length > 1) {
      return system;
    }
  }
  throw new Error(`seed ${SEED} has no multi-planet system with an atmosphere`);
}

const SYSTEM = fixtureSystem();
const BODIES = buildPlanetBodies(SYSTEM);

describe('buildPlanetBodies (TASK-83)', () => {
  it('builds one body per planet at its sim anchor', () => {
    expect(BODIES).toHaveLength(SYSTEM.planets.length);
    for (let i = 0; i < SYSTEM.planets.length; i++) {
      const a = planetAnchor(i);
      expect(BODIES[i].planetId).toBe(SYSTEM.planets[i].id);
      expect(BODIES[i].anchor).toEqual({ x: a.x, y: 0, z: a.z });
      expect(BODIES[i].group.position.x).toBe(a.x);
      expect(BODIES[i].group.position.y).toBe(0);
      expect(BODIES[i].group.position.z).toBe(a.z);
    }
  });

  it('gives the dome shell ONLY to atmospheric planets', () => {
    for (const body of BODIES) {
      const planet = SYSTEM.planets[body.index];
      expect(body.hasAtmosphere).toBe(planet.hasAtmosphere);
      if (planet.hasAtmosphere) {
        expect(body.shell).not.toBeNull();
        const sphere = (body.shell!.geometry as import('three').SphereGeometry).parameters;
        expect(sphere.radius).toBeCloseTo(ATMOSPHERE_BOUNDARY_M * DOME_RADIUS_FACTOR, 6);
      } else {
        expect(body.shell).toBeNull();
      }
    }
  });

  it('sizes the island slab to the shared surface extent (top just below y = 0)', () => {
    for (const body of BODIES) {
      const slab = body.group.children[0] as import('three').Mesh;
      const cyl = slab.geometry as import('three').CylinderGeometry;
      expect(cyl.parameters.radiusTop).toBeCloseTo(PLANET_SURFACE_RADIUS_M, 6);
      expect(cyl.parameters.radiusBottom).toBeCloseTo(PLANET_SURFACE_RADIUS_M * 0.9, 6);
      // slab top = group origin (y = 0 anchor) + (position.y + height/2) = -2.
      const top = slab.position.y + cyl.parameters.height / 2;
      expect(top).toBeCloseTo(-2, 6);
    }
  });

  it('splits the slab top into its own mesh (TASK-84) at the same plane', () => {
    for (const body of BODIES) {
      // The top cap is a separate mesh sharing the slab material, flat at
      // y = -2 in group space — hiding it never changes the side wall.
      const circle = body.slabTop.geometry as import('three').CircleGeometry;
      expect(circle.parameters.radius).toBeCloseTo(PLANET_SURFACE_RADIUS_M, 6);
      expect(body.slabTop.position.y).toBeCloseTo(-2, 6);
      expect(body.slabTop.material).toBe(
        (body.group.children[0] as import('three').Mesh).material,
      );
      expect(body.slabTop.visible).toBe(true);
    }
  });
});

describe('updatePlanetBodies (TASK-83 scaled proxy per frame)', () => {
  it('near camera: true position and scale 1', () => {
    const bodies = buildPlanetBodies(SYSTEM);
    const anchor = bodies[0].anchor;
    // 800 m short of planet 0's anchor: inside PROXY_START_M (3000).
    updatePlanetBodies(bodies, vec(anchor.x - 800, 0, 0));
    expect(bodies[0].group.position.x).toBeCloseTo(anchor.x, 8);
    expect(bodies[0].group.position.y).toBeCloseTo(0, 8);
    expect(bodies[0].group.scale.x).toBe(1);
  });

  it('far camera: the group moves to PROXY_DISTANCE_M along the exact direction, scaled down', () => {
    const bodies = buildPlanetBodies(SYSTEM);
    const anchor = bodies[0].anchor; // (10 000, 0, 0)
    const cam = vec(45_000, 300, 0);
    updatePlanetBodies(bodies, cam);
    const g = bodies[0].group.position;
    const dx = anchor.x - cam.x;
    const dy = anchor.y - cam.y;
    const dz = anchor.z - cam.z;
    const distance = Math.hypot(dx, dy, dz);
    const k = PROXY_DISTANCE_M / distance;
    expect(g.x).toBeCloseTo(cam.x + dx * k, 8);
    expect(g.y).toBeCloseTo(cam.y + dy * k, 8);
    expect(g.z).toBeCloseTo(cam.z + dz * k, 8);
    expect(bodies[0].group.scale.x).toBeCloseTo(k, 8);
    // Every planet ends up exactly PROXY_DISTANCE_M from the camera.
    for (const body of bodies) {
      const p = body.group.position;
      const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      expect(d).toBeCloseTo(PROXY_DISTANCE_M, 6);
    }
  });
});

describe('setPlanetShellHidden (TASK-83 inside-atmosphere rule)', () => {
  it('hides only the named planet shell; null shows all', () => {
    const bodies = buildPlanetBodies(SYSTEM);
    const withShell = bodies.find((b) => b.shell !== null)!;
    const others = bodies.filter((b) => b !== withShell);

    setPlanetShellHidden(bodies, withShell.planetId);
    expect(withShell.shell!.visible).toBe(false);
    for (const b of others) if (b.shell) expect(b.shell.visible).toBe(true);

    setPlanetShellHidden(bodies, null);
    for (const b of bodies) if (b.shell) expect(b.shell.visible).toBe(true);
  });
});
