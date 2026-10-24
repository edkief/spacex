import { describe, it, expect } from 'vitest';
import { generateSystem } from './system';
import { generateStars } from './stars';

const GOLDEN_SEED = 'drift-dev-seed-001';

describe('System Generator', () => {
  it('is deterministic', () => {
    const stars = generateStars(GOLDEN_SEED);
    const starId = stars[0].id;

    const sys1 = generateSystem(GOLDEN_SEED, starId);
    const sys2 = generateSystem(GOLDEN_SEED, starId);

    expect(sys1).toEqual(sys2);
  });

  it('follows basic constraints', () => {
    const stars = generateStars(GOLDEN_SEED);
    const starId = stars[0].id;
    const sys = generateSystem(GOLDEN_SEED, starId);

    expect(sys.planets.length).toBeGreaterThanOrEqual(2);
    expect(sys.planets.length).toBeLessThanOrEqual(6);

    for (const p of sys.planets) {
      // Gas giants are never landable
      if (p.class === 'gas') {
        expect(p.landable).toBe(false);
        expect(p.dockCount).toBe(0);
      }

      // Landable planets must have docks
      if (p.landable) {
        expect(p.dockCount).toBeGreaterThanOrEqual(1);
        expect(p.dockCount).toBeLessThanOrEqual(3);
      } else {
        // Non-landable planets (gas or just unlucky) can have 0 docks.
        // In our implementation, if !landable, docks = 0.
        expect(p.dockCount).toBe(0);
      }

      expect(p.resourceTypes.length).toBeGreaterThanOrEqual(1);
      expect(p.resourceTypes.length).toBeLessThanOrEqual(3);

      expect(p.aiRoster.count).toBeGreaterThanOrEqual(2);
      expect(p.aiRoster.count).toBeLessThanOrEqual(5);
      expect(p.aiRoster.classes.length).toBe(p.aiRoster.count);
    }
  });

  it('meets statistical requirements (landable + atmosphere)', () => {
    const stars = generateStars(GOLDEN_SEED);
    let landableWithAtmosphereCount = 0;
    const numSystems = 200;

    for (let i = 0; i < numSystems; i++) {
      // Use a rotating set of stars if there are fewer than 200, but here we have 200.
      const starId = stars[i % stars.length].id;
      const sys = generateSystem(GOLDEN_SEED, starId);

      const hasLandableWithAtmosphere = sys.planets.some((p) => p.landable && p.hasAtmosphere);
      if (hasLandableWithAtmosphere) {
        landableWithAtmosphereCount++;
      }
    }

    const percentage = (landableWithAtmosphereCount / numSystems) * 100;
    console.log(`Systems with landable+atmosphere: ${percentage}%`);
    expect(percentage).toBeGreaterThanOrEqual(80);
  });

  it('golden snapshot for star #0 of dev seed', () => {
    const stars = generateStars(GOLDEN_SEED);
    const starId = stars[0].id;
    const sys = generateSystem(GOLDEN_SEED, starId);

    expect(sys).toEqual({
      systemId: 'bcca5917d3bbbeef',
      name: 'Alpha Sirius Epsilon system',
      star: {
        class: 'G',
        name: 'Alpha Sirius Epsilon',
      },
      planets: [
        {
          id: 'p-0',
          name: 'Nova IX',
          class: 'terran',
          radiusKm: 7857,
          hasAtmosphere: true,
          landable: true,
          dockCount: 1,
          resourceTypes: ['iron', 'copper'],
          aiRoster: {
            count: 4,
            classes: ['interceptor', 'scout', 'scout', 'interceptor'],
          },
        },
        {
          id: 'p-1',
          name: 'Pyros Beta',
          class: 'rocky',
          radiusKm: 3079,
          hasAtmosphere: false,
          landable: true,
          dockCount: 3,
          resourceTypes: ['water', 'copper'],
          aiRoster: {
            count: 3,
            classes: ['interceptor', 'scout', 'scout'],
          },
        },
        {
          id: 'p-2',
          name: 'Gaea Gamma',
          class: 'ice',
          radiusKm: 3699,
          hasAtmosphere: false,
          landable: true,
          dockCount: 2,
          resourceTypes: ['water'],
          aiRoster: {
            count: 2,
            classes: ['scout', 'freighter'],
          },
        },
        {
          id: 'p-3',
          name: 'Thalassa Beta',
          class: 'ocean',
          radiusKm: 3652,
          hasAtmosphere: true,
          landable: true,
          dockCount: 1,
          resourceTypes: ['water', 'rare-earths'],
          aiRoster: {
            count: 3,
            classes: ['scout', 'scout', 'interceptor'],
          },
        },
        {
          id: 'p-4',
          name: 'Hestia Gamma',
          class: 'gas',
          radiusKm: 59893,
          hasAtmosphere: true,
          landable: false,
          dockCount: 0,
          resourceTypes: ['iron', 'copper'],
          aiRoster: {
            count: 4,
            classes: ['interceptor', 'freighter', 'freighter', 'scout'],
          },
        },
        {
          id: 'p-5',
          name: 'Zephyr Minor',
          class: 'ice',
          radiusKm: 4146,
          hasAtmosphere: true,
          landable: true,
          dockCount: 1,
          resourceTypes: ['copper', 'iron'],
          aiRoster: {
            count: 5,
            classes: ['interceptor', 'scout', 'scout', 'interceptor', 'freighter'],
          },
        },
      ],
    });
  });
});
