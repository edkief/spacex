import { describe, expect, it } from 'vitest';

import {
  dropFrom,
  emptyInventory,
  INVENTORY_MAX_WEIGHT,
  inventoryWeight,
  listStacks,
  pickupInto,
  RESOURCE_WEIGHTS,
  sanitizeInventory,
  stackWeight,
  toPlayerInventory,
  weightRemaining,
} from './inventory';

describe('shared inventory model (TASK-34)', () => {
  it('pins the v1 catalog weights (iron 1, copper 1, rare-earth 2, crystal 3)', () => {
    expect(RESOURCE_WEIGHTS.iron).toBe(1);
    expect(RESOURCE_WEIGHTS.copper).toBe(1);
    expect(RESOURCE_WEIGHTS['rare-earth']).toBe(2);
    expect(RESOURCE_WEIGHTS.crystal).toBe(3);
    expect(INVENTORY_MAX_WEIGHT).toBe(40);
    expect(stackWeight('crystal', 13)).toBe(39); // ~13 crystal ≈ the cap
    expect(stackWeight('iron', 20)).toBe(20); // 20 iron = half the cap
  });

  it('computes weight over stacks (unknown ids and zeros count nothing)', () => {
    expect(inventoryWeight(emptyInventory())).toBe(0);
    expect(inventoryWeight({ iron: 5, crystal: 2 })).toBe(5 + 6);
    // @ts-expect-error - deliberately foreign id: must be ignored, not crash
    expect(inventoryWeight({ iron: 1, gold: 99 })).toBe(1);
    expect(inventoryWeight({ iron: 0 })).toBe(0);
  });

  it('partial pickup at the boundary takes exactly what fits', () => {
    // 39/40 iron, take 5 → 1 fits, 4 stays on the ground.
    const a = pickupInto({ iron: 39 }, 'iron', 5);
    expect(a.taken).toBe(1);
    expect(a.remaining).toBe(4);
    expect(a.stacks).toEqual({ iron: 40 });
    // Full inventory takes nothing.
    const b = pickupInto({ iron: 40 }, 'iron', 1);
    expect(b.taken).toBe(0);
    expect(b.remaining).toBe(1);
    // Weight cap across types: 36 iron + 1 crystal = 39 → one free unit →
    // exactly one more iron fits.
    const c = pickupInto({ iron: 36, crystal: 1 }, 'iron', 3);
    expect(c.taken).toBe(1);
    expect(c.remaining).toBe(2);
    // Fractional room never grants a unit (floor of room / per-unit weight).
    const d = pickupInto({ iron: 39 }, 'crystal', 1); // room 1 < 3
    expect(d.taken).toBe(0);
    expect(d.remaining).toBe(1);
    expect(weightRemaining({ iron: 40 })).toBe(0);
  });

  it('drop + re-pickup round trip conserves units', () => {
    const start = { iron: 6, copper: 2 };
    const drop = dropFrom(start, 'iron', 4);
    expect(drop.dropped).toBe(4);
    expect(drop.stacks).toEqual({ iron: 2, copper: 2 });
    // Dropping more than owned drops only what is owned.
    const over = dropFrom(drop.stacks, 'iron', 5);
    expect(over.dropped).toBe(2);
    expect(over.remaining).toBe(3);
    expect(over.stacks).toEqual({ copper: 2 }); // zero-amount stack removed
    // Round trip: drop 4 iron, take it all back, take 2 more.
    const ground = 4;
    const back = pickupInto(over.stacks, 'iron', ground);
    expect(back.taken).toBe(4);
    const more = pickupInto(back.stacks, 'iron', 2);
    expect(more.taken).toBe(2);
    expect(more.stacks.iron).toBe(6);
  });

  it('sanitizes corrupt persisted inventory (players.inventory JSON)', () => {
    expect(sanitizeInventory(null)).toEqual({});
    expect(sanitizeInventory('iron')).toEqual({});
    expect(sanitizeInventory({ iron: 3, copper: -1 })).toEqual({ iron: 3 });
    expect(sanitizeInventory({ iron: 1.5 })).toEqual({});
    expect(sanitizeInventory({ gold: 10 })).toEqual({}); // unknown id dropped
    expect(sanitizeInventory({ iron: 0, crystal: 2 })).toEqual({ crystal: 2 });
    expect(sanitizeInventory({ iron: Number.POSITIVE_INFINITY })).toEqual({});
    // Sanitize + weight stays within the cap math (no NaN ever).
    const s = sanitizeInventory({ iron: 10, crystal: 10 });
    expect(Number.isFinite(inventoryWeight(s))).toBe(true);
    expect(toPlayerInventory(s).weightUsed).toBe(10 + 30);
  });

  it('lists stacks in catalog order, zero amounts dropped', () => {
    expect(listStacks({ iron: 1, crystal: 2 })).toEqual([
      { resourceId: 'iron', amount: 1 },
      { resourceId: 'crystal', amount: 2 },
    ]);
    expect(listStacks({ crystal: 1, iron: 0 })).toEqual([{ resourceId: 'crystal', amount: 1 }]);
    expect(listStacks(emptyInventory())).toEqual([]);
  });

  it('guards degenerate amounts', () => {
    expect(pickupInto(emptyInventory(), 'iron', 0)).toEqual({
      stacks: {},
      taken: 0,
      remaining: 0,
    });
    expect(dropFrom(emptyInventory(), 'iron', 0)).toEqual({
      stacks: {},
      dropped: 0,
      remaining: 0,
    });
    expect(dropFrom(emptyInventory(), 'crystal', 3)).toEqual({
      stacks: {},
      dropped: 0,
      remaining: 3,
    });
  });
});
