import { describe, expect, it } from 'vitest';

import type { CargoHold } from './cargo';
import type { InventoryStacks } from './inventory';
import { sellUnitPrice, sellFrom, sellableTotal } from './sell';

/**
 * TASK-40 step 4: the dock sell's pure price math + source selection
 * (shared/sell.ts). Covers the ACs:
 * - sellUnitPrice: the catalog base price per resource (the single read
 *   site for prices), unknown id throws;
 * - sellFrom: the two sources (hold / inv) each decrement EXACTLY one
 *   stack, recompute the hold's weight, grant sold × basePrice; a request
 *   short of the source is an 'insufficient' denial (nothing moves);
 *   invalid resource / amount are rejected up front; both result stacks are
 *   NEW objects (the source is never mutated);
 * - sellableTotal: hold + on-foot inventory combined (the UI's sellable).
 */

function hold(stacks: InventoryStacks, capacity = 40): CargoHold {
  return { stacks, weightUsed: Object.values(stacks).reduce((a, b) => a + b, 0), capacity };
}

describe('sellUnitPrice — the catalog base price (the single price read site)', () => {
  it('returns the AC-pinned base price for every v1 resource', () => {
    expect(sellUnitPrice('iron')).toBe(5);
    expect(sellUnitPrice('copper')).toBe(8);
    expect(sellUnitPrice('rare-earth')).toBe(25);
    expect(sellUnitPrice('crystal')).toBe(60);
  });

  it('throws for a resource id outside the v1 catalog', () => {
    expect(() => sellUnitPrice('plutonium')).toThrow(/unknown resource/);
  });
});

describe('sellFrom — source selection (hold vs inv)', () => {
  it("source 'hold': decrements the HOLD stack, recomputes its weight, leaves the inventory untouched", () => {
    const h = hold({ iron: 10 });
    const inv: InventoryStacks = { copper: 3 };
    const res = sellFrom(h, inv, 'iron', 4, 'hold');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sold).toBe(4);
    expect(res.earned).toBe(4 * 5); // 20 credits
    expect(res.hold.stacks).toEqual({ iron: 6 });
    expect(res.hold.weightUsed).toBe(6);
    expect(res.hold.capacity).toBe(40);
    expect(res.inv).toBe(inv); // same reference — the inv source was not touched
    expect(h.stacks).toEqual({ iron: 10 }); // the original hold was NOT mutated
  });

  it("source 'inv': decrements the INVENTORY stack, leaves the hold untouched", () => {
    const h = hold({ iron: 10 });
    const inv: InventoryStacks = { iron: 10, crystal: 2 };
    const res = sellFrom(h, inv, 'iron', 7, 'inv');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.earned).toBe(7 * 5); // 35 credits
    expect(res.inv).toEqual({ iron: 3, crystal: 2 });
    expect(res.hold).toBe(h); // same reference — the hold was not touched
    expect(inv.iron).toBe(10); // the original inventory was NOT mutated
  });

  it('sell-all removes the now-empty key (no 0-count stack lingers)', () => {
    const inv: InventoryStacks = { copper: 3 };
    const res = sellFrom(hold({}), inv, 'copper', 3, 'inv');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.inv).toEqual({});
    expect(res.earned).toBe(3 * 8); // 24 credits
  });

  it('the hold weight is recomputed across multiple resources (never subtracted blind)', () => {
    // iron 1 (w1) + crystal 2 (w3) = 1 + 6 = 7 u; sell 1 crystal → 1 + 3 = 4 u
    const h: CargoHold = { stacks: { iron: 1, crystal: 2 }, weightUsed: 7, capacity: 40 };
    const res = sellFrom(h, {}, 'crystal', 1, 'hold');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hold.weightUsed).toBe(4);
    expect(res.earned).toBe(1 * 60); // 60 credits
  });
});

describe('sellFrom — denial ladder (each leaves the source untouched)', () => {
  it('invalid resource → invalid-resource (never reaches the stacks)', () => {
    const res = sellFrom(hold({ iron: 5 }), { iron: 5 }, 'plutonium', 1, 'hold');
    expect(res).toEqual({ ok: false, code: 'invalid-resource', resourceId: 'plutonium' });
  });

  it.each([[0], [-3], [2.5]])('invalid amount %i → invalid-amount', (amount) => {
    const res = sellFrom(hold({ iron: 5 }), { iron: 5 }, 'iron', amount, 'hold');
    expect(res).toEqual({ ok: false, code: 'invalid-amount', amount });
  });

  it('insufficient: a request over the source is denied with what IS available', () => {
    const res = sellFrom(hold({ iron: 3 }), { iron: 3 }, 'iron', 5, 'hold');
    expect(res).toEqual({ ok: false, code: 'insufficient', resourceId: 'iron', available: 3 });
  });

  it('insufficient is source-specific: 5 in the hold but none in the inv', () => {
    const res = sellFrom(hold({ iron: 5 }), {}, 'iron', 1, 'inv');
    expect(res).toEqual({ ok: false, code: 'insufficient', resourceId: 'iron', available: 0 });
  });
});

describe('sellableTotal — hold + on-foot inventory combined', () => {
  it('sums the same resource across both sources', () => {
    expect(sellableTotal(hold({ iron: 4 }), { iron: 3 }, 'iron')).toBe(7);
  });

  it('is 0 when neither source holds the resource', () => {
    expect(sellableTotal(hold({ copper: 2 }), { iron: 1 }, 'crystal')).toBe(0);
  });
});
