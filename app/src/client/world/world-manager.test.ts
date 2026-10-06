import { describe, expect, it } from 'vitest';

import {
  buildSystemLayout,
  CAMERA_FAR,
  PAD_RING_VISIBLE_RANGE_M,
  padRingVisible,
  padRingsFor,
  PLANET_COLORS,
  STAR_COLORS,
  WORLD_BUILD_BUDGET_MS,
  WORLD_FIRST_ORBIT,
  WORLD_ORBIT_STEP,
  WORLD_PLANET_COUNT,
  WORLD_PLANET_RADIUS,
} from './WorldManager';
import { DOME_RADIUS_FACTOR } from '@client/render/atmosphere-dome';
import { ATMOSPHERE_BOUNDARY_M } from '@shared/physics/atmosphere';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { SPAWN_GATE_POS } from '@shared/galaxy/spawn';
import { padsForSystem, PAD_RADIUS_M } from '@shared/world/pads';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import type { Vec3 } from '@shared/physics/vec';

/**
 * TASK-8 world-swap layout: the pure, deterministic near-field (star,
 * first N planets, spawn gate) behind WorldManager.swapWorld. three.js is
 * never exercised here — the layout is the testable contract, and the e2e
 * asserts the measured build time stays under WORLD_BUILD_BUDGET_MS.
 */

const SEED = 'world-manager-test-seed';
const stars = generateStars(SEED, 4);
const sys0 = generateSystem(SEED, stars[0].id);
const sys1 = generateSystem(SEED, stars[1].id);

describe('buildSystemLayout (TASK-8)', () => {
  it('is deterministic: the same system always yields the same layout', () => {
    expect(buildSystemLayout(sys0)).toEqual(buildSystemLayout(sys0));
  });

  it('differs across systems (seeded orbit angles, star class, id)', () => {
    const a = buildSystemLayout(sys0);
    const b = buildSystemLayout(sys1);
    expect(a.systemId).not.toBe(b.systemId);
    expect(a).not.toEqual(b);
  });

  it('carries the star class and its spectral color', () => {
    const layout = buildSystemLayout(sys0);
    expect(layout.starClass).toBe(sys0.star.class);
    expect(layout.starColor).toBe(STAR_COLORS[sys0.star.class]);
  });

  it('lays out at most WORLD_PLANET_COUNT planets on spaced orbits with class colors', () => {
    const layout = buildSystemLayout(sys0);
    expect(layout.planets.length).toBe(Math.min(WORLD_PLANET_COUNT, sys0.planets.length));
    layout.planets.forEach((p, i) => {
      expect(p.planetId).toBe(sys0.planets[i].id);
      expect(p.color).toBe(PLANET_COLORS[sys0.planets[i].class]);
      expect(p.radius).toBe(WORLD_PLANET_RADIUS);
      expect(p.orbitRadius).toBe(WORLD_FIRST_ORBIT + i * WORLD_ORBIT_STEP);
      expect(p.angle).toBeGreaterThanOrEqual(0);
      expect(p.angle).toBeLessThan(Math.PI * 2);
    });
  });

  it('puts the spawn gate exactly at the shared SPAWN_GATE_POS (100 u +X)', () => {
    expect(buildSystemLayout(sys0).gate).toEqual({ ...SPAWN_GATE_POS });
    expect(WORLD_BUILD_BUDGET_MS).toBe(300);
  });
});

/**
 * TASK-29.3: pad ring markers. padRingsFor is the pure half of swapWorld's
 * pad-list presence (same deterministic list as the server, cached inside
 * the shared module); padRingVisible is the per-frame culling predicate.
 */
function fakeSystem(landable: boolean[]): Pick<SystemGen, 'systemId' | 'planets'> {
  const mk = (i: number): Planet => ({
    id: `p${i}`,
    name: `P${i}`,
    class: 'terran',
    radiusKm: 3000,
    hasAtmosphere: true,
    landable: landable[i],
    dockCount: 1,
    resourceTypes: ['iron'],
    aiRoster: { count: 1, classes: ['scout'] },
  });
  return { systemId: 'pad-ring-sys', planets: [mk(0), mk(1), mk(2)] };
}

describe('pad ring markers (TASK-29.3)', () => {
  it('padRingsFor derives one ring per pad from the SHARED pad list', () => {
    const sys = fakeSystem([true, false, true]);
    const pads = padsForSystem(SEED, sys);
    expect(pads.length).toBe(2); // one pad per LANDABLE planet
    const rings = padRingsFor(SEED, sys);
    expect(rings.length).toBe(2);
    rings.forEach((r, i) => {
      expect(r.padId).toBe(pads[i].padId);
      expect(r.x).toBe(pads[i].pos.x);
      expect(r.y).toBe(pads[i].pos.y);
      expect(r.z).toBe(pads[i].pos.z);
      expect(r.radius).toBe(pads[i].radius);
      expect(r.radius).toBe(PAD_RADIUS_M);
    });
  });

  it('is deterministic: the same (seed, system) always yields the same rings', () => {
    const sys = fakeSystem([true, false, true]);
    expect(padRingsFor(SEED, sys)).toEqual(padRingsFor(SEED, sys));
  });

  it('padRingVisible is a pure 500 m range check (3-D, inclusive)', () => {
    const pad: Vec3 = { x: 100, y: 5, z: -200 };
    expect(PAD_RING_VISIBLE_RANGE_M).toBe(500);
    expect(padRingVisible(null, pad)).toBe(false); // no position yet
    expect(padRingVisible({ ...pad }, pad)).toBe(true);
    expect(padRingVisible({ x: pad.x + PAD_RING_VISIBLE_RANGE_M, y: pad.y, z: pad.z }, pad)).toBe(
      true,
    ); // exactly 500 m: visible
    expect(
      padRingVisible({ x: pad.x + PAD_RING_VISIBLE_RANGE_M + 1, y: pad.y, z: pad.z }, pad),
    ).toBe(false); // 501 m: hidden
    // Y distance counts too (a pad 400 m below at 300 m horizontal is ~500 m out)
    expect(padRingVisible({ x: pad.x + 300, y: pad.y - 400, z: pad.z }, pad)).toBe(true);
    expect(padRingVisible({ x: pad.x + 300, y: pad.y - 401, z: pad.z }, pad)).toBe(false);
  });
});

/**
 * TASK-76 — the far-plane invariant. This is the guard that stops a future
 * change from re-introducing the "black sky inside the atmosphere" clip:
 * the dome (radius ATMOSPHERE_BOUNDARY_M × DOME_RADIUS_FACTOR) has a longest
 * chord of 2 × that radius, so the far plane must reach at least that far to
 * never clip the far wall from any point inside the dome. It must also clear
 * the 420 u sky radius the skybox is centred on (TASK-75).
 */
describe('CAMERA_FAR (TASK-76) contains the whole atmosphere dome', () => {
  it('reaches the dome\'s longest chord (2 × radius), so the far wall is never clipped', () => {
    const domeDiameter = 2 * ATMOSPHERE_BOUNDARY_M * DOME_RADIUS_FACTOR;
    expect(CAMERA_FAR).toBeGreaterThanOrEqual(domeDiameter);
  });

  it('comfortably exceeds the sky radius the skybox is centred on (420 u)', () => {
    expect(CAMERA_FAR).toBeGreaterThan(420);
  });
});
