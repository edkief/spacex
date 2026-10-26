import { describe, it, expect } from 'vitest';
import { regimeFor } from './regime';
import { getRegimePlanetContexts } from './galaxy/regime-planets';

describe('Regime Integration', () => {
  it('should handle a full flight cycle (space -> atmosphere -> surface -> atmosphere -> space)', () => {
    const seed = 'test-seed';
    const starId = 'abc123def';
    // Mock planets for the generator
    const planets = [
      {
        id: 'p1',
        radiusKm: 1000,
        atmosphereHeight: 100,
        atmosphereDensity: 1.0,
        hasAtmosphere: true,
        // other fields not used by getRegimePlanetContexts
      },
    ];
    const contexts = getRegimePlanetContexts(seed, starId, planets);
    const planetPos = contexts[0].pos;
    const zeroVel = { x: 0, y: 0, z: 0 };
    const slowVel = { x: 0, y: 0, z: 0 }; // speed < 10

    let currentRegime: FlightRegime = 'space';
    let pos = { x: planetPos.x, y: planetPos.y, z: planetPos.z + 2000000 }; // Deep space

    // 1. Space -> Atmosphere
    pos.z = planetPos.z + 1050000; // Inside enter radius (1100k)
    const r1 = regimeFor(pos, zeroVel, contexts, currentRegime);
    expect(r1.regime).toBe('atmosphere');
    currentRegime = r1.regime;

    // 2. Atmosphere -> Surface
    pos.z = planetPos.z + 1000001; // Inside surface offset (1000k + 2)
    const r2 = regimeFor(pos, slowVel, contexts, currentRegime);
    expect(r2.regime).toBe('surface');
    currentRegime = r2.regime;

    // 3. Surface -> Atmosphere
    pos.z = planetPos.z + 1000005; // Above surface offset
    const r3 = regimeFor(pos, zeroVel, contexts, currentRegime);
    expect(r3.regime).toBe('atmosphere');
    currentRegime = r3.regime;

    // 4. Atmosphere -> Space
    pos.z = planetPos.z + 1200000; // Outside exit radius (1100k * 1.05 = 1155k)
    const r4 = regimeFor(pos, zeroVel, contexts, currentRegime);
    expect(r4.regime).toBe('space');
    currentRegime = r4.regime;
  });
});
