import { describe, expect, it } from 'vitest';

import {
  CARGO_SLOT_WEIGHT,
  cargoCapacityFor,
  cargoWeightRemaining,
  emptyCargoHold,
  parseCargoJson,
  sanitizeCargo,
  toCargoHold,
  transferCargo,
} from './cargo';
import { INVENTORY_MAX_WEIGHT } from './inventory';
import { SHIP_CLASSES, shipStats } from './ships';

/**
 * TASK-39 step 1/4: the cargo-hold contract — the capacity math (class
 * cargoSlots × 10: scout 40, interceptor 20, freighter 120) and the atomic
 * transfer (partial at the boundary in both directions).
 */

describe('cargoCapacityFor (capacity = cargoSlots × 10, AC-pinned)', () => {
  it('derives the hold capacity from the ONE class stat (cargoSlots)', () => {
    for (const cls of Object.values(SHIP_CLASSES)) {
      expect(cargoCapacityFor(cls.id)).toBe(cls.cargoSlots * CARGO_SLOT_WEIGHT);
      // One stat drives both: the capacity is cargoSlots × 10, nothing else.
      expect(cargoCapacityFor(cls.id)).toBe(shipStats(cls.id).cargoSlots * 10);
    }
  });

  it('is the AC-pinned set: scout 40, interceptor 20, freighter 120', () => {
    expect(cargoCapacityFor('scout')).toBe(40);
    expect(cargoCapacityFor('interceptor')).toBe(20);
    expect(cargoCapacityFor('freighter')).toBe(120);
  });

  it('the freighter carries ~3× a scout (the economic differentiator)', () => {
    expect(cargoCapacityFor('freighter') / cargoCapacityFor('scout')).toBe(3);
  });

  it('an unknown class throws (same contract as shipStats)', () => {
    expect(() => cargoCapacityFor('dreadnought')).toThrow();
  });
});

describe('hold construction + weight', () => {
  it('emptyCargoHold starts at 0/0 with the class capacity', () => {
    expect(emptyCargoHold('scout')).toEqual({ stacks: {}, weightUsed: 0, capacity: 40 });
  });

  it('toCargoHold recomputes weightUsed from the stacks (never stored blind)', () => {
    const hold = toCargoHold({ iron: 10, crystal: 1 }, 'freighter');
    expect(hold.weightUsed).toBe(10 * 1 + 1 * 3);
    expect(hold.capacity).toBe(120);
    expect(cargoWeightRemaining(hold)).toBe(120 - 13);
  });
});

describe('parseCargoJson / sanitizeCargo (corrupt rows never wedge a shard)', () => {
  it('parses a valid stacks JSON', () => {
    expect(parseCargoJson('{"iron":10,"crystal":2}')).toEqual({ iron: 10, crystal: 2 });
  });

  it('empty / null / corrupt / non-object all yield {}', () => {
    expect(parseCargoJson(null)).toEqual({});
    expect(parseCargoJson('')).toEqual({});
    expect(parseCargoJson('{nope')).toEqual({});
    expect(parseCargoJson('[1,2]')).toEqual({});
    expect(sanitizeCargo(null)).toEqual({});
  });

  it('drops unknown resources, non-integers, negatives, and zero amounts', () => {
    expect(
      parseCargoJson(
        JSON.stringify({ iron: 2, uranium: 9, copper: 1.5, crystal: -3, rareEarth: 0 }),
      ),
    ).toEqual({ iron: 2 });
  });
});

describe('transferCargo (atomic, partial at the boundary)', () => {
  it('from inv: loads the whole amount into an empty hold', () => {
    const hold = emptyCargoHold('scout');
    const res = transferCargo(hold, { iron: 10 }, 'iron', 10, 'inv');
    expect(res).toEqual({
      hold: { stacks: { iron: 10 }, weightUsed: 10, capacity: 40 },
      inv: {},
      moved: 10,
      remaining: 0,
    });
  });

  it('from inv: PARTIAL when the hold nears its cap (AC: 39/40, load 5 → 1)', () => {
    const hold = toCargoHold({ iron: 39 }, 'scout');
    const res = transferCargo(hold, { iron: 5 }, 'iron', 5, 'inv');
    expect(res.moved).toBe(1);
    expect(res.remaining).toBe(4);
    expect(res.hold.stacks).toEqual({ iron: 40 });
    expect(res.hold.weightUsed).toBe(40);
    expect(res.inv).toEqual({ iron: 4 });
  });

  it('from inv: a full hold moves 0 (nothing to do, no mutation)', () => {
    const hold = toCargoHold({ iron: 40 }, 'scout');
    const res = transferCargo(hold, { iron: 3 }, 'iron', 3, 'inv');
    expect(res).toMatchObject({ moved: 0, remaining: 3 });
    expect(res.hold).toBe(hold); // the same object back (a no-op)
    expect(res.inv).toEqual({ iron: 3 });
  });

  it('from inv: bounded by what is owned (asking for 99 moves only what exists)', () => {
    const hold = emptyCargoHold('freighter');
    const res = transferCargo(hold, { copper: 4 }, 'copper', 99, 'inv');
    expect(res.moved).toBe(4);
    expect(res.hold.stacks).toEqual({ copper: 4 });
    expect(res.inv).toEqual({});
  });

  it('from inv: respects per-unit WEIGHT (crystal 3 u — 13 u room fits 4, not 5)', () => {
    const hold = toCargoHold({ iron: 27 }, 'scout'); // 27/40 → 13 u room
    const res = transferCargo(hold, { crystal: 9 }, 'crystal', 9, 'inv');
    expect(res.moved).toBe(4); // 4 × 3 = 12 u fits; a 5th needs 15
    expect(res.hold.weightUsed).toBe(39);
    expect(res.inv).toEqual({ crystal: 5 });
  });

  it('from hold: unloads into the weight-capped inventory (40 u cap)', () => {
    const hold = toCargoHold({ iron: 10, crystal: 2 }, 'freighter');
    const res = transferCargo(hold, { iron: 37 }, 'crystal', 2, 'hold');
    // 37 u used + 2 crystal (6 u) = 43 > 40 → only ONE crystal fits.
    expect(res.moved).toBe(1);
    expect(res.hold.stacks).toEqual({ iron: 10, crystal: 1 });
    expect(res.inv).toEqual({ iron: 37, crystal: 1 });
  });

  it('from hold: moves 0 when the inventory is full (denial, not a throw)', () => {
    const hold = toCargoHold({ iron: 5 }, 'scout');
    const res = transferCargo(hold, { iron: 40 }, 'iron', 5, 'hold');
    expect(res.moved).toBe(0);
    expect(res.remaining).toBe(5);
    expect(res.inv).toEqual({ iron: 40 });
    expect(res.hold.stacks).toEqual({ iron: 5 });
  });

  it('never mutates its inputs (the shard replaces both stacks atomically)', () => {
    const hold = toCargoHold({ iron: 1 }, 'scout');
    const inv = { iron: 2 } as Record<string, number>;
    transferCargo(hold, inv, 'iron', 1, 'inv');
    expect(hold.stacks).toEqual({ iron: 1 });
    expect(inv).toEqual({ iron: 2 });
  });

  it('non-positive amounts are no-ops', () => {
    const hold = emptyCargoHold('scout');
    expect(transferCargo(hold, { iron: 3 }, 'iron', 0, 'inv')).toMatchObject({ moved: 0 });
    expect(transferCargo(hold, { iron: 3 }, 'iron', -2, 'inv')).toMatchObject({ moved: 0 });
  });

  it('the inventory side keeps the shared 40 u cap (INVENTORY_MAX_WEIGHT)', () => {
    const hold = toCargoHold({ iron: 40 }, 'freighter');
    const res = transferCargo(hold, {}, 'iron', 40, 'hold');
    expect(res.moved).toBe(40);
    expect(res.inv).toEqual({ iron: 40 });
    expect(res.hold.stacks).toEqual({});
    expect(INVENTORY_MAX_WEIGHT).toBe(40);
  });
});
