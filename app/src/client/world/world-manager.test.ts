import { describe, expect, it } from 'vitest';

import {
  buildSystemLayout,
  PLANET_COLORS,
  STAR_COLORS,
  WORLD_BUILD_BUDGET_MS,
  WORLD_FIRST_ORBIT,
  WORLD_ORBIT_STEP,
  WORLD_PLANET_COUNT,
  WORLD_PLANET_RADIUS,
} from './WorldManager';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { SPAWN_GATE_POS } from '@shared/galaxy/spawn';

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
