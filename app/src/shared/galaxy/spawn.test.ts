import { describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { listSpawnSystems, pickSpawnSystem } from '@shared/galaxy/spawn.ts';

const SEED = 'drift-dev-seed-001';
const spawns = listSpawnSystems(SEED);

describe('listSpawnSystems', () => {
  it('lists only systems with a landable planet that has a dock', () => {
    expect(spawns.length).toBeGreaterThan(100);
    for (const spawn of spawns) {
      const star = generateStars(SEED).find((s) => s.id === spawn.starId)!;
      const system = generateSystemForStar(SEED, star);
      expect(system.systemId).toBe(spawn.systemId);
      expect(system.planets.some((p) => p.landable && p.dockCount >= 1)).toBe(true);
    }
  });

  it('excludes star #0 of the dev seed (gas giants only) and is deterministic', () => {
    const star0 = generateSystemForStar(SEED, generateStars(SEED)[0]!);
    expect(spawns.map((s) => s.systemId)).not.toContain(star0.systemId);
    expect(listSpawnSystems(SEED)).toEqual(spawns);
  });

  it('has unique system ids', () => {
    expect(new Set(spawns.map((s) => s.systemId)).size).toBe(spawns.length);
  });
});

describe('pickSpawnSystem', () => {
  it('is a pure function of the player id', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(pickSpawnSystem(spawns, id)).toEqual(pickSpawnSystem(spawns, id));
  });

  it('spreads players across many systems', () => {
    const chosen = new Set<string>();
    for (let i = 0; i < 400; i++) chosen.add(pickSpawnSystem(spawns, `player-${i}`).systemId);
    expect(chosen.size).toBeGreaterThan(80);
  });

  it('refuses an empty list', () => {
    expect(() => pickSpawnSystem([], 'x')).toThrow(RangeError);
  });
});
