import { describe, expect, it } from 'vitest';

import { generateSystem } from '../galaxy/system';
import { RESOURCE_CATALOG, pickResource } from '../resources';
import { RESOURCE_IDS, RESOURCE_WEIGHTS, type ResourceId } from '../inventory';
import { Rng, seedFromString } from '../random';
import {
  DEPOSIT_AMOUNT_MAX,
  DEPOSIT_AMOUNT_MIN,
  DEPOSIT_MAX_PER_SYSTEM,
  DEPOSIT_MIN_SPACING_M,
  depositsFor,
  planetHeightAt,
  __resetDepositCache,
} from './deposits';

const SEED = 'deposits-test-seed';

/** Three distinct real systems of one galaxy (different star ids). */
const SYSTEMS = [generateSystem(SEED, 'star-a'), generateSystem(SEED, 'star-b'), generateSystem(SEED, 'star-c')];

/** The eligible (solid) planets of a system, in orbital order. */
const eligiblePlanets = (systemId: string) =>
  SYSTEMS.find((s) => s.systemId === systemId)!.planets.filter(
    (p) => p.landable && p.class !== 'ocean' && p.class !== 'gas',
  );

describe('depositsFor: seeded placement (TASK-37 AC)', () => {
  const STAR_IDS = ['star-a', 'star-b', 'star-c'];
  it.each(SYSTEMS.map((s, i) => [s, STAR_IDS[i]] as const))(
    'system %s.systemId: deterministic list (3 systems: same seed → identical, cache-cold)',
    (system, starId) => {
      __resetDepositCache();
      const a = depositsFor(SEED, system);
      __resetDepositCache();
      // Re-derive from a FRESH generateSystem call + cold cache — the list
      // must be byte-identical (the placement is a pure function of the seed).
      const b = depositsFor(SEED, generateSystem(SEED, starId));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    },
  );

  it.each(SYSTEMS.map((s) => s.systemId))('%s: ≤ 120 deposits, amounts 10..50, undiscovered, known resources, solid planets only', (systemId) => {
    const system = SYSTEMS.find((s) => s.systemId === systemId)!;
    const deps = depositsFor(SEED, system);
    expect(deps.length).toBeLessThanOrEqual(DEPOSIT_MAX_PER_SYSTEM);
    expect(deps.length).toBeGreaterThan(0);
    const planetIds = new Set(eligiblePlanets(systemId).map((p) => p.id));
    for (const d of deps) {
      expect(d.amount).toBeGreaterThanOrEqual(DEPOSIT_AMOUNT_MIN);
      expect(d.amount).toBeLessThanOrEqual(DEPOSIT_AMOUNT_MAX);
      expect(d.discovered).toBe(false);
      expect(RESOURCE_IDS).toContain(d.resourceId);
      expect(planetIds).toContain(d.planetId);
      expect(d.depositId).toBe(`${systemId}:${d.depositSeq}`);
      expect(Number.isFinite(d.pos.x)).toBe(true);
      expect(Number.isFinite(d.pos.y)).toBe(true);
      expect(Number.isFinite(d.pos.z)).toBe(true);
    }
    // depositSeq is a 0-based contiguous sequence (the DB key suffix).
    expect(deps.map((d) => d.depositSeq)).toEqual(deps.map((_, i) => i));
  });

  it.each(SYSTEMS.map((s) => s.systemId))('%s: min spacing ≥ 200 m per planet', (systemId) => {
    const deps = depositsFor(SEED, SYSTEMS.find((s) => s.systemId === systemId)!);
    const byPlanet = new Map<string, typeof deps>();
    for (const d of deps) {
      const arr = byPlanet.get(d.planetId) ?? [];
      arr.push(d);
      byPlanet.set(d.planetId, arr);
    }
    for (const arr of byPlanet.values()) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const dist = Math.hypot(arr[i].pos.x - arr[j].pos.x, arr[i].pos.z - arr[j].pos.z);
          expect(dist, `deposits ${arr[i].depositId}/${arr[j].depositId}`).toBeGreaterThanOrEqual(DEPOSIT_MIN_SPACING_M);
        }
      }
    }
  });

  it.each(SYSTEMS.map((s) => s.systemId))('%s: every deposit sits on the terrain surface (heightAt ≈ pos.y ± 0.5)', (systemId) => {
    const system = SYSTEMS.find((s) => s.systemId === systemId)!;
    for (const d of depositsFor(SEED, system)) {
      const planet = system.planets.find((p) => p.id === d.planetId)!;
      const h = planetHeightAt(SEED, planet, d.pos.x, d.pos.z);
      expect(Math.abs(h - d.pos.y), `${d.depositId}: ${h} vs ${d.pos.y}`).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('resource catalog (TASK-37 AC)', () => {
  it('weights match the inventory catalog exactly (no second weight table)', () => {
    for (const id of RESOURCE_IDS) {
      expect(RESOURCE_CATALOG[id].weight).toBe(RESOURCE_WEIGHTS[id]);
    }
  });

  it('AC-pinned base prices: iron 5, copper 8, rare-earth 25, crystal 60', () => {
    expect(RESOURCE_CATALOG.iron.basePrice).toBe(5);
    expect(RESOURCE_CATALOG.copper.basePrice).toBe(8);
    expect(RESOURCE_CATALOG['rare-earth'].basePrice).toBe(25);
    expect(RESOURCE_CATALOG.crystal.basePrice).toBe(60);
  });

  it('spawn weights are the 40/30/20/10 contract and sum to 1', () => {
    expect(RESOURCE_CATALOG.iron.spawnWeight).toBe(0.4);
    expect(RESOURCE_CATALOG.copper.spawnWeight).toBe(0.3);
    expect(RESOURCE_CATALOG['rare-earth'].spawnWeight).toBe(0.2);
    expect(RESOURCE_CATALOG.crystal.spawnWeight).toBe(0.1);
    const sum = RESOURCE_IDS.reduce((acc, id) => acc + RESOURCE_CATALOG[id].spawnWeight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('pickResource: a fixed Rng draws the 40/30/20/10 mix (10k draws, ±3 pts)', () => {
    const rng = new Rng(seedFromString('pick-mix'));
    const counts: Record<string, number> = {};
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const id = pickResource(rng);
      counts[id] = (counts[id] ?? 0) + 1;
    }
    for (const id of RESOURCE_IDS) {
      const share = (counts[id] ?? 0) / N;
      expect(Math.abs(share - RESOURCE_CATALOG[id].spawnWeight)).toBeLessThan(0.03);
    }
  });
});

/** Keep the ResourceId import live (used by the catalog contract above). */
type _assert = Record<ResourceId, number>;
