import { describe, expect, it } from 'vitest';

import { MOUNT_RANGE_M, MOUNT_RELEASE_RANGE_M, chunkInSurface, terrainPlanetFor } from './planet-terrain';
import { PLANET_SURFACE_RADIUS_M } from '@shared/galaxy/planets';
import type { Planet, SystemGen } from '@shared/galaxy/types';

/**
 * TASK-84 (step 3): the pure mount-target decision + the island clip.
 *
 * Anchors (planetAnchor): planet i sits at ((i + 1) × 10 000, 0). MOUNT_RANGE
 * is the surface radius (2000 m) + 2000 m = 4000 m; the current planet is
 * kept to +500 m (4500 m) — the hysteresis band.
 */

function makePlanet(id: string, landable: boolean): Planet {
  return {
    id,
    name: id,
    class: landable ? 'terran' : 'gas',
    radiusKm: 3000,
    hasAtmosphere: true,
    landable,
    dockCount: 1,
    resourceTypes: ['iron'],
    aiRoster: { count: 1, classes: ['scout'] },
  };
}

/** Three planets: landable, GAS GIANT, landable — anchors 10k / 20k / 30k. */
const SYSTEM: SystemGen = {
  systemId: 'sys-terrain-unit',
  name: 'Terrain unit system',
  star: { class: 'G', name: 'Terrainstar' },
  planets: [makePlanet('p-land-0', true), makePlanet('p-gas-1', false), makePlanet('p-land-2', true)],
};

describe('terrainPlanetFor (TASK-84 mount target)', () => {
  it('exports the contract constants', () => {
    expect(MOUNT_RANGE_M).toBe(PLANET_SURFACE_RADIUS_M + 2000);
    expect(MOUNT_RELEASE_RANGE_M).toBe(MOUNT_RANGE_M + 500);
  });

  it('far from every planet → null', () => {
    expect(terrainPlanetFor({ x: 0, y: 0, z: 0 }, SYSTEM, null)).toBeNull();
    // Even from between planets, beyond 4 km of every landable anchor.
    expect(terrainPlanetFor({ x: 15000, y: 0, z: 0 }, SYSTEM, null)).toBeNull();
  });

  it('approaching a landable planet → its id', () => {
    // 500 m from planet 2's anchor (30 000), well outside planet 0's range.
    expect(terrainPlanetFor({ x: 29500, y: 0, z: 0 }, SYSTEM, null)).toBe('p-land-2');
    // The NEAREST landable planet wins when two are in range…
    expect(terrainPlanetFor({ x: 12000, y: 0, z: 0 }, SYSTEM, null)).toBe('p-land-0');
    // …even if it is not the one the player is "between".
    expect(terrainPlanetFor({ x: 27000, y: 0, z: 0 }, SYSTEM, null)).toBe('p-land-2');
  });

  it('non-landable planets (gas giants) never mount', () => {
    // Dead on the gas giant's anchor, no current: it is skipped.
    expect(terrainPlanetFor({ x: 20000, y: 0, z: 0 }, SYSTEM, null)).toBeNull();
    // A STALE current id that is the gas giant releases immediately.
    expect(terrainPlanetFor({ x: 20000, y: 0, z: 0 }, SYSTEM, 'p-gas-1')).toBeNull();
  });

  it('hysteresis: the current planet is kept inside the release band, never re-acquired there', () => {
    // 4 300 m out: beyond the 4 km acquire range but inside the 4.5 km release.
    const far = { x: 10000 + 4300, y: 0, z: 0 };
    expect(terrainPlanetFor(far, SYSTEM, 'p-land-0')).toBe('p-land-0'); // held
    expect(terrainPlanetFor(far, SYSTEM, null)).toBeNull(); // not re-acquired
    // Inside the acquire range, a different planet can WIN (the nearest rule
    // applies once the current one has released — here both in range, P0 nearer).
    expect(terrainPlanetFor({ x: 10000 + 3900, y: 0, z: 0 }, SYSTEM, 'p-land-2')).toBe('p-land-0');
  });

  it('a stale current id (not in this system) releases to the nearest in range', () => {
    expect(terrainPlanetFor({ x: 10500, y: 0, z: 0 }, SYSTEM, 'p-ghost')).toBe('p-land-0');
  });
});

describe('chunkInSurface (TASK-84 island clip)', () => {
  const anchor = { x: 10000, z: 0 };

  it('chunks the surface circle crosses are kept', () => {
    // The chunk containing the anchor itself.
    expect(chunkInSurface(31, 0, anchor)).toBe(true); // 9920–10240 × 0–320
    // Tangent-ish: the circle reaches into it (clamped distance 1600 m).
    expect(chunkInSurface(31, 5, anchor)).toBe(true); // z 1600–1920
    // Diagonal corner: clamped point (10240, 1600) at 1619 m < 2000 m.
    expect(chunkInSurface(32, 5, anchor)).toBe(true);
  });

  it('chunks past the surface circle are clipped', () => {
    // 2240 m from the anchor at the nearest edge (the circle spans x 8000–12000).
    expect(chunkInSurface(31, 7, anchor)).toBe(false); // z 2240–2560
    expect(chunkInSurface(38, 0, anchor)).toBe(false); // x 12160–12480
    expect(chunkInSurface(23, 0, anchor)).toBe(false); // x 7360–7680
    expect(chunkInSurface(-40, -40, anchor)).toBe(false);
  });
});
