import { describe, expect, it } from 'vitest';

import { SHIP_CLASSES } from '@shared/ships';
import { applyDamage, repairCost, type DamageSource, type DamageShip } from './damage';

/**
 * Shared damage model (TASK-23): shield-first ordering with exact boundary
 * cases, the double-destroy guard, and the dock repair cost table.
 */

const player: DamageSource = { kind: 'player', id: 'p-attacker' };
const ai: DamageSource = { kind: 'ai', id: 'rogue-1' };
const ship = (hull: number, shields: number): DamageShip => ({ hull, shields });

describe('applyDamage: shield-first ordering', () => {
  it('shields absorb a hit below capacity: hull untouched', () => {
    expect(applyDamage(ship(100, 50), 30, player)).toEqual({
      shieldHit: 30,
      hullHit: 0,
      destroyed: false,
    });
  });

  it('boundary: a hit EXACTLY at shield capacity empties shields, hull untouched', () => {
    expect(applyDamage(ship(100, 50), 50, player)).toEqual({
      shieldHit: 50,
      hullHit: 0,
      destroyed: false,
    });
  });

  it('boundary: one point over capacity overflows exactly one point to hull', () => {
    expect(applyDamage(ship(100, 50), 51, player)).toEqual({
      shieldHit: 50,
      hullHit: 1,
      destroyed: false,
    });
  });

  it('overflow past half shields splits shield/hull correctly', () => {
    expect(applyDamage(ship(100, 50), 70, ai)).toEqual({
      shieldHit: 50,
      hullHit: 20,
      destroyed: false,
    });
  });

  it('with empty shields the full hit reaches the hull', () => {
    expect(applyDamage(ship(100, 0), 40, player)).toEqual({
      shieldHit: 0,
      hullHit: 40,
      destroyed: false,
    });
  });

  it('boundary: a hit EXACTLY at shields + hull destroys (hull reaches zero)', () => {
    expect(applyDamage(ship(100, 50), 150, player)).toEqual({
      shieldHit: 50,
      hullHit: 100,
      destroyed: true,
    });
  });

  it('float accumulation: a hit at the remaining hull STILL destroys (TASK-42 epsilon)', () => {
    // Normalized fractions accumulate float error in the sim (0.3 of 100
    // leaves 30.000000000000004, not 30): an exactly-lethal hit must count.
    expect(applyDamage(ship(30.000000000000004, 0), 30, player)).toEqual({
      shieldHit: 0,
      hullHit: 30,
      destroyed: true,
    });
    // ...while one point short still does not.
    expect(applyDamage(ship(30.000000000000004, 0), 29, player)).toEqual({
      shieldHit: 0,
      hullHit: 29,
      destroyed: false,
    });
  });

  it('overkill is capped at the remaining hull: no negative hull damage', () => {
    expect(applyDamage(ship(100, 50), 5000, player)).toEqual({
      shieldHit: 50,
      hullHit: 100,
      destroyed: true,
    });
  });

  it('empty hull: the guard no-ops even when shields are full (no post-mortem damage)', () => {
    expect(applyDamage(ship(0, 50), 30, player)).toEqual({
      shieldHit: 0,
      hullHit: 0,
      destroyed: false,
    });
  });
});

describe('applyDamage: guards and purity', () => {
  it('zero and negative damage are no-ops', () => {
    for (const amount of [0, -5, -100]) {
      expect(applyDamage(ship(100, 50), amount, player)).toEqual({
        shieldHit: 0,
        hullHit: 0,
        destroyed: false,
      });
    }
  });

  it('double-destroy guard: a hull-0 ship takes no damage and never reports destroyed again', () => {
    expect(applyDamage(ship(0, 0), 1000, player)).toEqual({
      shieldHit: 0,
      hullHit: 0,
      destroyed: false,
    });
  });

  it('is pure: the input ship is never mutated', () => {
    const s = ship(100, 50);
    const before = JSON.parse(JSON.stringify(s));
    applyDamage(s, 160, ai);
    expect(s).toEqual(before);
  });

  it('is deterministic: identical inputs give identical results', () => {
    const a = applyDamage(ship(123.5, 41.25), 67, player);
    const b = applyDamage(ship(123.5, 41.25), 67, ai);
    expect(a).toEqual(b);
  });
});

describe('repairCost: dock repair price table (TASK-23)', () => {
  it('a ship at class caps costs 0 for every class', () => {
    for (const cls of Object.values(SHIP_CLASSES)) {
      expect(repairCost(cls.id, cls.hull, cls.shieldCapacity)).toBe(0);
    }
  });

  it('a destroyed ship (0/0) costs 15 for every class', () => {
    for (const cls of Object.values(SHIP_CLASSES)) {
      expect(repairCost(cls.id, 0, 0)).toBe(15);
    }
  });

  // Exact binary fractions (0.25/0.5/0.75) keep the ceil() boundaries clean.
  it('prices per exact damage fraction: ceil((1 - hullFrac) * 10) + ceil((1 - shieldFrac) * 5)', () => {
    // hull 75% → ceil(2.5) = 3 ; shields 75% → ceil(1.25) = 2
    expect(repairCost('scout', 75, 37.5)).toBe(3 + 2);
    // hull 50% → 5 ; shields 50% → ceil(2.5) = 3
    expect(repairCost('scout', 50, 25)).toBe(5 + 3);
    // hull 25% → ceil(7.5) = 8 ; shields 25% → ceil(3.75) = 4
    expect(repairCost('scout', 25, 12.5)).toBe(8 + 4);
    // hull full → 0 ; shields empty → 5
    expect(repairCost('scout', 100, 0)).toBe(0 + 5);
  });

  it('scales with the class caps (same fractions, different absolute damage)', () => {
    // freighter: hull 200 / shields 80 at 50% → 5 + 3
    expect(repairCost('freighter', 100, 40)).toBe(5 + 3);
    // interceptor: hull 80 / shields 40 at 75% → 3 + 2
    expect(repairCost('interceptor', 60, 30)).toBe(3 + 2);
  });

  it('rounds up per band: any damage inside a band pays the whole band', () => {
    // hull 90/100 → 10% missing → ceil(1.0) = 1 (the float lands just below,
    // still 1); one point less damage (99/100) is still 1, not 0.
    expect(repairCost('scout', 90, 50)).toBe(1);
    expect(repairCost('scout', 99, 50)).toBe(1);
    // shields 49/50 → 2% missing → ceil(0.1) = 1, not 0.
    expect(repairCost('scout', 100, 49)).toBe(1);
  });

  it('clamps out-of-range values instead of pricing imaginary damage', () => {
    expect(repairCost('scout', 1000, 500)).toBe(0); // over-full
    expect(repairCost('scout', -50, -10)).toBe(15); // under-zero
  });
});
