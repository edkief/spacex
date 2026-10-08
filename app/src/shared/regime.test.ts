import { describe, expect, it } from 'vitest';

import {
  CRUISE_CLEARANCE_M,
  REGIME_EXIT_FACTOR,
  SURFACE_ENTER_ALT_M,
  SURFACE_HYSTERESIS_M,
  SURFACE_SPEED_LIMIT_M_S,
  cruiseAllowedAt,
  regimeFor,
  type RegimePlanet,
} from './regime';
import { planetAtmosphereRadius, systemRegimePlanets, planetAnchor } from './galaxy/planets';
import type { Planet } from './galaxy/types';

/** One landable, atmospheric test planet at the first anchor slot. */
const PLANET: Planet = {
  id: 'planet-a',
  name: 'Varda',
  class: 'terran',
  radiusKm: 3000,
  hasAtmosphere: true,
  landable: true,
  dockCount: 1,
  resourceTypes: ['iron'],
  aiRoster: { count: 2, classes: ['scout', 'scout'] },
};
const R = 1000; // atmosphere radius (u)
const EXIT = R * REGIME_EXIT_FACTOR; // 1050

/** Atmosphere planet at the origin anchor (flat terrain). */
const A: RegimePlanet = { id: 'planet-a', x: 0, z: 0, atmosphereRadius: R, landable: true };
/** Airless twin. */
const B: RegimePlanet = { id: 'planet-b', x: 5000, z: 0, atmosphereRadius: 0, landable: false };

describe('regimeFor: atmosphere boundary', () => {
  it('resolves space far from any planet', () => {
    expect(regimeFor({ x: 9000, y: 0, z: 0 }, [A]).regime).toBe('space');
  });

  it('enters the atmosphere strictly inside the enter radius (exact radius stays out)', () => {
    // Exactly at the radius: d == R is NOT inside (enter is strict <).
    expect(regimeFor({ x: R, y: 0, z: 0 }, [A], 'space').regime).toBe('space');
    // 1 u inside: enter.
    expect(regimeFor({ x: R - 1, y: 0, z: 0 }, [A], 'space').regime).toBe('atmosphere');
    // Entering returns the owning planet.
    expect(regimeFor({ x: R - 1, y: 0, z: 0 }, [A], 'space').planetId).toBe('planet-a');
  });

  it('leaves only at the exit radius (enter * 1.05)', () => {
    // A FAST flyby (above the surface speed limit) holds the atmosphere
    // inside the hysteresis band [R, EXIT) — a slow low ship would resolve
    // to the surface sub-state instead (covered below).
    expect(
      regimeFor({ x: R + 1, y: 0, z: 0 }, [A], 'atmosphere', SURFACE_SPEED_LIMIT_M_S + 5).regime,
    ).toBe('atmosphere');
    expect(
      regimeFor({ x: EXIT - 0.5, y: 0, z: 0 }, [A], 'atmosphere', SURFACE_SPEED_LIMIT_M_S + 5)
        .regime,
    ).toBe('atmosphere');
    // Exactly at the exit radius: out (checked before any surface logic).
    expect(regimeFor({ x: EXIT, y: 0, z: 0 }, [A], 'atmosphere').regime).toBe('space');
  });

  it('uses 3D distance (altitude counts toward the boundary)', () => {
    // y = 600, x = 800 → d = 1000 exactly → space from space.
    expect(regimeFor({ x: 800, y: 600, z: 0 }, [A], 'space').regime).toBe('space');
    // y = 500, x = 867 → d ≈ 1000.84 > R → space.
    expect(regimeFor({ x: 867, y: 500, z: 0 }, [A], 'space').regime).toBe('space');
    // y = 500, x = 865 → d ≈ 999.11 < R → atmosphere.
    expect(regimeFor({ x: 865, y: 500, z: 0 }, [A], 'space').regime).toBe('atmosphere');
  });

  it('hysteresis: no regime flip inside the band (anti-flap under ±1 u noise)', () => {
    // Idling in the band [R, EXIT) — 50 m wide at the 1 km radius — the
    // current regime must hold no matter how the position jitters.
    for (let i = 0; i < 200; i++) {
      const jitter = (i % 2 === 0 ? 1 : -1) * (1 + (i % 3)); // ±1..3 u noise
      const x = (R + EXIT) / 2 + jitter; // band midpoint
      // Fast flyby: the band assertion is about the ATMOSPHERE boundary, so
      // the ship is above the surface speed limit (else it resolves to the
      // surface sub-state at ground level).
      const fromAtmo = regimeFor({ x, y: 0, z: 0 }, [A], 'atmosphere', 10).regime;
      expect(fromAtmo).toBe('atmosphere');
    }
    for (let i = 0; i < 200; i++) {
      const jitter = (i % 2 === 0 ? 1 : -1) * (1 + (i % 3));
      const x = (R + EXIT) / 2 + jitter;
      const fromSpace = regimeFor({ x, y: 0, z: 0 }, [A], 'space').regime;
      expect(fromSpace).toBe('space');
    }
  });

  it('airless planets (atmosphereRadius 0) never yield atmosphere', () => {
    const airless: RegimePlanet = {
      id: 'airless',
      x: 1000,
      z: 0,
      atmosphereRadius: 0,
      landable: true,
    };
    // No atmosphere band: even from 'atmosphere' it resolves space.
    expect(regimeFor({ x: 1000, y: 500, z: 0 }, [airless], 'atmosphere').regime).toBe('space');
  });

  it('TASK-87: a LANDABLE airless planet yields surface on its solid disc', () => {
    const airless: RegimePlanet = {
      id: 'airless',
      x: 1000,
      z: 0,
      atmosphereRadius: 0,
      landable: true,
      heightAt: () => 0,
    };
    // Low + slow + on the ground inside the 2 km disc: surface (directly
    // from space — an airless body has no atmosphere to step through).
    expect(regimeFor({ x: 1000, y: 0, z: 0 }, [airless], 'space', 0)).toEqual({
      regime: 'surface',
      planetId: 'airless',
    });
    expect(regimeFor({ x: 1000, y: 1.9, z: 0 }, [airless], 'space', SURFACE_SPEED_LIMIT_M_S).regime).toBe(
      'surface',
    );
    // Surface hysteresis: holds in the band, drops to space above it.
    const bandTop = SURFACE_ENTER_ALT_M + SURFACE_HYSTERESIS_M; // 6 u
    expect(regimeFor({ x: 1000, y: 5, z: 0 }, [airless], 'surface', 0).regime).toBe('surface');
    expect(regimeFor({ x: 1000, y: bandTop + 0.5, z: 0 }, [airless], 'surface', 0).regime).toBe(
      'space',
    );
    // Fast low flyby: space (not surface) — the flight model's friction slows
    // it down before the machine counts it as landed.
    expect(
      regimeFor({ x: 1000, y: 0, z: 0 }, [airless], 'space', SURFACE_SPEED_LIMIT_M_S + 1).regime,
    ).toBe('space');
    // Outside the surface disc: space even when low and slow.
    expect(
      regimeFor(
        { x: 1000 + 2001, y: 0, z: 0 },
        [airless],
        'space',
        0,
      ).regime,
    ).toBe('space');
    // Non-landable airless bodies never yield surface.
    const moon: RegimePlanet = {
      id: 'moon',
      x: 1000,
      z: 0,
      atmosphereRadius: 0,
      landable: false,
    };
    expect(regimeFor({ x: 1000, y: 0, z: 0 }, [moon], 'space', 0).regime).toBe('space');
  });

  it('nearest planet wins; ties break deterministically on id', () => {
    // Radius 1500 so the tie point (1000 from each) is strictly INSIDE the
    // enter radius — at exactly R the entry check (strict <) stays space.
    const p1: RegimePlanet = { id: 'pb', x: 2000, z: 0, atmosphereRadius: 1500, landable: true };
    const p2: RegimePlanet = { id: 'pa', x: 0, z: 0, atmosphereRadius: 1500, landable: true };
    // 500 from p2, 1500 from p1 → p2 owns.
    expect(regimeFor({ x: 500, y: 0, z: 0 }, [p1, p2], 'space')).toEqual({
      regime: 'atmosphere',
      planetId: 'pa',
    });
    // Equidistant (1000 from each): id tie-break → 'pa' < 'pb'.
    expect(regimeFor({ x: 1000, y: 0, z: 0 }, [p1, p2], 'space').planetId).toBe('pa');
  });

  it('returns space with no planets', () => {
    expect(regimeFor({ x: 0, y: 0, z: 0 }, [])).toEqual({ regime: 'space' });
  });
});

describe('regimeFor: surface transitions', () => {
  const flat: RegimePlanet = { ...A, heightAt: () => 0 };

  it('NO direct space → surface transition (even low + slow inside the atmosphere)', () => {
    // Resting on the surface inside the atmosphere, current regime 'space':
    // the machine steps to 'atmosphere' first, never straight to 'surface'.
    expect(regimeFor({ x: 0, y: 0, z: 0 }, [flat], 'space', 0)).toEqual({
      regime: 'atmosphere',
      planetId: 'planet-a',
    });
  });

  it('atmosphere → surface below terrain + 2 u while slow', () => {
    expect(regimeFor({ x: 0, y: 1.9, z: 0 }, [flat], 'atmosphere', 4.9).regime).toBe('surface');
    // At the enter altitude exactly (alt == 2): not below → atmosphere.
    expect(regimeFor({ x: 0, y: SURFACE_ENTER_ALT_M, z: 0 }, [flat], 'atmosphere', 0).regime).toBe(
      'atmosphere',
    );
    // Fast low flyby (speed > limit): atmosphere, not surface.
    expect(
      regimeFor({ x: 0, y: 1, z: 0 }, [flat], 'atmosphere', SURFACE_SPEED_LIMIT_M_S + 0.1).regime,
    ).toBe('atmosphere');
    // At the speed limit exactly: surface (≤, not <).
    expect(
      regimeFor({ x: 0, y: 1, z: 0 }, [flat], 'atmosphere', SURFACE_SPEED_LIMIT_M_S).regime,
    ).toBe('surface');
  });

  it('surface → atmosphere above the hysteresis band or when fast', () => {
    const bandTop = SURFACE_ENTER_ALT_M + SURFACE_HYSTERESIS_M; // 6 u
    // Inside the band (alt 5, slow): stays surface (no flap).
    expect(regimeFor({ x: 0, y: 5, z: 0 }, [flat], 'surface', 0).regime).toBe('surface');
    // Above the band: atmosphere.
    expect(regimeFor({ x: 0, y: bandTop + 0.5, z: 0 }, [flat], 'surface', 0).regime).toBe(
      'atmosphere',
    );
    // Low but fast: atmosphere.
    expect(regimeFor({ x: 0, y: 1, z: 0 }, [flat], 'surface', 9).regime).toBe('atmosphere');
    // Surface hysteresis holds under ±1 u noise across the enter altitude.
    for (let i = 0; i < 100; i++) {
      const jitter = i % 2 === 0 ? 1 : -1;
      const y = (SURFACE_ENTER_ALT_M + SURFACE_HYSTERESIS_M) / 2 + jitter;
      expect(regimeFor({ x: 0, y, z: 0 }, [flat], 'surface', 0).regime).toBe('surface');
    }
  });

  it('measures altitude against the planet terrain (heightAt)', () => {
    const hilly: RegimePlanet = { ...A, heightAt: () => 100 };
    // y = 101 is alt 1 (slow) → surface; y = 102 is alt 2 → atmosphere.
    expect(regimeFor({ x: 0, y: 101, z: 0 }, [hilly], 'atmosphere', 0).regime).toBe('surface');
    expect(regimeFor({ x: 0, y: 102, z: 0 }, [hilly], 'atmosphere', 0).regime).toBe('atmosphere');
  });

  it('non-landable planets never yield surface', () => {
    const gas: RegimePlanet = { id: 'gas', x: 0, z: 0, atmosphereRadius: R, landable: false };
    expect(regimeFor({ x: 0, y: 0, z: 0 }, [gas], 'atmosphere', 0).regime).toBe('atmosphere');
  });

  it('outside the atmosphere there is no surface (space/space only)', () => {
    // Low + slow but outside the exit radius → space (not surface).
    expect(regimeFor({ x: 1200, y: 0, z: 0 }, [flat], 'atmosphere', 0)).toEqual({
      regime: 'space',
    });
  });
});

describe('regimeFor: determinism + shared client/server inputs', () => {
  it('is pure: identical inputs → identical results, every call', () => {
    const pos = { x: 950, y: 40, z: -10 };
    const first = regimeFor(pos, [A, B], 'atmosphere', 3.5);
    for (let i = 0; i < 50; i++) {
      expect(regimeFor({ ...pos }, [{ ...A }, { ...B }], 'atmosphere', 3.5)).toEqual(first);
    }
  });

  it('returns identical results for client and server built planet sets', () => {
    // Server path: the shared galaxy derivation; client path: the same
    // planet data mapped locally. Both feed the SAME regimeFor, so the
    // regimes must match bit-for-bit at every probe point.
    const serverPlanets = systemRegimePlanets({ planets: [PLANET] });
    const clientPlanets: RegimePlanet[] = [
      {
        id: PLANET.id,
        x: planetAnchor(0).x,
        z: planetAnchor(0).z,
        atmosphereRadius: planetAtmosphereRadius(PLANET),
        landable: PLANET.landable,
      },
    ];
    expect(serverPlanets).toEqual(clientPlanets);
    const probes = [
      { x: planetAnchor(0).x + 3000, y: 300, z: 0 }, // space
      { x: planetAnchor(0).x, y: 950, z: 0 }, // atmosphere (inside)
      { x: planetAnchor(0).x, y: 1, z: 0 }, // surface candidate
      { x: planetAnchor(0).x, y: 1049, z: 0 }, // hysteresis band
    ];
    for (const p of probes) {
      const server = regimeFor(p, serverPlanets, 'space', 0);
      const client = regimeFor(p, clientPlanets, 'space', 0);
      expect(client).toEqual(server);
    }
  });
});

describe('cruiseAllowedAt (TASK-85)', () => {
  // A sits at the origin with the full 1 km atmosphere: the no-cruise
  // zone is a R + CRUISE_CLEARANCE_M = 2 500 u sphere around its anchor.
  it('is false at 2 400 m from the anchor and true at 2 600 m', () => {
    expect(R + CRUISE_CLEARANCE_M).toBe(2500);
    const planets = [A];
    expect(cruiseAllowedAt({ x: 2400, y: 0, z: 0 }, planets)).toBe(false);
    expect(cruiseAllowedAt({ x: 2600, y: 0, z: 0 }, planets)).toBe(true);
    // exactly on the boundary is allowed (>=)
    expect(cruiseAllowedAt({ x: 2500, y: 0, z: 0 }, planets)).toBe(true);
  });

  it('uses 3D distance (altitude counts) and every planet must be clear', () => {
    const planets = [A];
    // horizontal 1 200 + altitude 2 400 → 3D distance 2 683 > 2 500
    expect(cruiseAllowedAt({ x: 1200, y: 2400, z: 0 }, planets)).toBe(true);
    const B = { id: 'planet-b', x: 10_000, z: 0, atmosphereRadius: R, landable: true };
    // clear of A (7 700) but not of B (2 300 < 2 500)
    expect(cruiseAllowedAt({ x: 7700, y: 0, z: 0 }, planets.concat(B))).toBe(false);
    // 9 000 off B's line → distance √(2300² + 9000²) > 2 500: clear of both
    expect(cruiseAllowedAt({ x: 7700, y: 0, z: 9_000 }, planets.concat(B))).toBe(true);
  });

  it('counts airless planets at ATMOSPHERE_BOUNDARY_M (no cruising into an island)', () => {
    const airless: RegimePlanet = { id: 'moon', x: 0, z: 0, atmosphereRadius: 0, landable: true };
    expect(cruiseAllowedAt({ x: 2400, y: 0, z: 0 }, [airless])).toBe(false);
    expect(cruiseAllowedAt({ x: 2600, y: 0, z: 0 }, [airless])).toBe(true);
  });

  it('allows cruise with no planets at all', () => {
    expect(cruiseAllowedAt({ x: 0, y: 0, z: 0 }, [])).toBe(true);
  });
});
