import { describe, it, expect } from 'vitest';
import { regimeFor, SURFACE_OFFSET } from './regime';
import { FlightRegime } from './physics/types';

describe('regimeFor', () => {
  const planets = [
    {
      id: 'p1',
      radiusKm: 1000,
      atmosphereHeight: 100,
    },
  ];
  const contexts = [
    {
      planet: planets[0],
      pos: { x: 0, y: 0, z: 0 },
    },
  ];
  const zeroVel = { x: 0, y: 0, z: 0 };
  const slowVel = { x: 5, y: 0, z: 0 };
  const fastVel = { x: 20, y: 0, z: 0 };

  it('should resolve space when far from planet', () => {
    const pos = { x: 0, y: 0, z: 2000 * 1000 };
    const result = regimeFor(pos, zeroVel, contexts, 'space');
    expect(result.regime).toBe('space');
  });

  it('should transition space -> atmosphere at enter radius', () => {
    const enterRadius = (1000 + 100) * 1000;
    const pos = { x: 0, y: 0, z: enterRadius - 1 };
    const result = regimeFor(pos, zeroVel, contexts, 'space');
    expect(result.regime).toBe('atmosphere');
    expect(result.planetId).toBe('p1');
  });

  it('should apply hysteresis when leaving atmosphere', () => {
    const enterRadius = (1000 + 100) * 1000;
    const exitRadius = enterRadius * 1.05;
    
    // Just inside exit radius, but outside enter radius
    const pos = { x: 0, y: 0, z: (enterRadius + exitRadius) / 2 };
    const result = regimeFor(pos, zeroVel, contexts, 'atmosphere');
    expect(result.regime).toBe('atmosphere');
    
    // Outside exit radius
    const posOut = { x: 0, y: 0, z: exitRadius + 1 };
    const resultOut = regimeFor(posOut, zeroVel, contexts, 'atmosphere');
    expect(resultOut.regime).toBe('space');
  });

  it('should transition atmosphere -> surface when slow and near surface', () => {
    const surfaceRadius = 1000 * 1000;
    const pos = { x: 0, y: 0, z: surfaceRadius + SURFACE_OFFSET - 1 };
    const result = regimeFor(pos, slowVel, contexts, 'atmosphere');
    expect(result.regime).toBe('surface');
  });

  it('should NOT transition atmosphere -> surface when fast', () => {
    const surfaceRadius = 1000 * 1000;
    const pos = { x: 0, y: 0, z: surfaceRadius + SURFACE_OFFSET - 1 };
    const result = regimeFor(pos, fastVel, contexts, 'atmosphere');
    expect(result.regime).toBe('atmosphere');
  });

  it('should transition surface -> atmosphere when ascending', () => {
    const surfaceRadius = 1000 * 1000;
    const pos = { x: 0, y: 0, z: surfaceRadius + SURFACE_OFFSET + 1 };
    const result = regimeFor(pos, zeroVel, contexts, 'surface');
    expect(result.regime).toBe('atmosphere');
  });

  it('should forbid direct space -> surface transition', () => {
    const surfaceRadius = 1000 * 1000;
    const pos = { x: 0, y: 0, z: surfaceRadius + 1 };
    const result = regimeFor(pos, slowVel, contexts, 'space');
    expect(result.regime).not.toBe('surface');
    expect(result.regime).toBe('atmosphere'); // Must enter atmosphere first
  });

  it('should hold hysteresis under noisy positions', () => {
    const enterRadius = 1100000;
    const exitRadius = 1155000;
    const pos = { x: 0, y: 0, z: 1120000 }; // Inside hysteresis band
    
    let regime = 'atmosphere';
    for (let i = 0; i < 100; i++) {
      const noisyPos = { x: 0, y: 0, z: pos.z + (Math.random() - 0.5) * 2 };
      const result = regimeFor(noisyPos, zeroVel, contexts, regime);
      regime = result.regime;
      expect(regime).toBe('atmosphere');
    }
  });
});
