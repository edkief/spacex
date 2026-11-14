import { describe, expect, it } from 'vitest';
import { SHIP_CLASS_IDS } from '@shared/ships/ids.ts';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystem, generateSystemForStar } from '@shared/galaxy/system.ts';
import {
  MAX_AI_COUNT,
  MAX_PLANETS,
  MIN_AI_COUNT,
  MIN_PLANETS,
  PLANET_PROFILES,
  RESOURCE_TYPES,
} from '@shared/galaxy/systemConfig.ts';

const SEED = 'drift-dev-seed-001';
const stars = generateStars(SEED);
const systems = stars.map((star) => generateSystemForStar(SEED, star));

describe('generateSystem', () => {
  it('is deterministic across calls and independent lookups', () => {
    const star = stars[3]!;
    const first = generateSystem(SEED, star.id);
    expect(generateSystem(SEED, star.id)).toEqual(first);
    expect(generateSystemForStar(SEED, star)).toEqual(first);
    expect(generateSystemForStar(SEED, { ...star })).toEqual(first);
  });

  it('names the system after its star and reports the star summary', () => {
    const star = stars[0]!;
    const system = generateSystem(SEED, star.id);
    expect(system.name).toBe(`${star.name} System`);
    expect(system.star).toMatchObject({ class: star.class, name: star.name });
    expect(system.star.radius).toBeGreaterThan(0);
    expect(system.systemId).toMatch(/^[0-9a-f]{16}$/);
    expect(system.systemId).not.toBe(star.id);
  });

  it('differs between stars and between seeds', () => {
    expect(systems[0]).not.toEqual(systems[1]);
    expect(generateSystemForStar('other-seed', stars[0]!).systemId).not.toBe(systems[0]!.systemId);
  });

  it('rejects malformed and unknown star ids', () => {
    expect(() => generateSystem(SEED, 'nope')).toThrow(RangeError);
    expect(() => generateSystem(SEED, '0000000000000000')).toThrow(/unknown star/);
  });

  it('honours a custom chart size when looking stars up', () => {
    const wide = generateStars(SEED, 250)[240]!;
    expect(() => generateSystem(SEED, wide.id)).toThrow(/unknown star/);
    expect(generateSystem(SEED, wide.id, 250).name).toBe(`${wide.name} System`);
  });
});

describe(`statistics over ${systems.length} systems`, () => {
  const planets = systems.flatMap((system) => system.planets);

  it('has 2-6 planets with unique ids and names', () => {
    for (const system of systems) {
      expect(system.planets.length).toBeGreaterThanOrEqual(MIN_PLANETS);
      expect(system.planets.length).toBeLessThanOrEqual(MAX_PLANETS);
      expect(new Set(system.planets.map((p) => p.name)).size).toBe(system.planets.length);
    }
    expect(new Set(planets.map((p) => p.id)).size).toBe(planets.length);
    for (const planet of planets) expect(planet.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('puts a landable planet with atmosphere in more than 80% of systems', () => {
    const good = systems.filter((s) => s.planets.some((p) => p.landable && p.hasAtmosphere));
    expect(good.length / systems.length).toBeGreaterThan(0.8);
  });

  it('never lands on gas giants and gives landable planets 1-3 docks', () => {
    for (const planet of planets) {
      if (planet.class === 'gas') expect(planet.landable).toBe(false);
      if (planet.landable) {
        expect(planet.dockCount).toBeGreaterThanOrEqual(1);
        expect(planet.dockCount).toBeLessThanOrEqual(3);
      } else {
        expect(planet.dockCount).toBe(0);
      }
    }
  });

  it('keeps radii inside the per-class ranges', () => {
    for (const planet of planets) {
      const [min, max] = PLANET_PROFILES[planet.class].radiusKm;
      expect(planet.radiusKm).toBeGreaterThanOrEqual(min);
      expect(planet.radiusKm).toBeLessThanOrEqual(max);
      expect(Number.isInteger(planet.radiusKm)).toBe(true);
    }
  });

  it('uses 1-3 distinct known resource types per planet', () => {
    for (const planet of planets) {
      expect(planet.resourceTypes.length).toBeGreaterThanOrEqual(1);
      expect(planet.resourceTypes.length).toBeLessThanOrEqual(3);
      expect(new Set(planet.resourceTypes).size).toBe(planet.resourceTypes.length);
      for (const type of planet.resourceTypes) expect(RESOURCE_TYPES).toContain(type);
    }
  });

  it('has AI rosters of 2-5 ships drawn from the known ship classes', () => {
    for (const planet of planets) {
      const { count, classes } = planet.aiRoster;
      expect(count).toBeGreaterThanOrEqual(MIN_AI_COUNT);
      expect(count).toBeLessThanOrEqual(MAX_AI_COUNT);
      expect(classes).toHaveLength(count);
      for (const id of classes) expect(SHIP_CLASS_IDS).toContain(id);
    }
  });

  it('produces every planet class', () => {
    expect(new Set(planets.map((p) => p.class))).toEqual(
      new Set(['terran', 'rocky', 'ocean', 'ice', 'gas']),
    );
  });
});
