/**
 * Dock-sell operations tests — TASK-40.
 *
 * Covers the pure-function math from `sellOps.ts`:
 *   - `priceFor(id)` returns the catalog base price.
 *   - `sellStack` debits a single source map and reports
 *     `{ sold, earned, remaining }`.
 *   - `totalSellable` combines inventory + cargo stacks.
 *   - Weight recomputation after a sale (cargo + inventory).
 *   - `isSellableResourceType` predicate membership.
 *
 * No DB, no shard state. These tests pin the math so the
 * route / WS handler can rely on it.
 */
import { describe, expect, it } from "vitest";

import { CARGO_RESOURCE_TYPES } from "./cargo.js";
import { cargoHoldFor } from "./cargo.js";
import { emptyInventory } from "./inventoryOps.js";
import type { CargoHold } from "./cargo.js";
import type { Inventory } from "./inventory.js";
import {
  isSellableResourceType,
  priceFor,
  recomputeCargoWeightAfterSell,
  recomputeInventoryWeightAfterSell,
  sellStack,
  totalSellable,
} from "./sellOps.js";

describe("sellOps: priceFor", () => {
  it("returns the catalog base price for every deposit resource", () => {
    expect(priceFor("iron")).toBe(5);
    expect(priceFor("copper")).toBe(8);
    expect(priceFor("rare-earths")).toBe(25);
    expect(priceFor("crystal")).toBe(60);
  });
});

describe("sellOps: isSellableResourceType", () => {
  it("accepts every deposit resource id", () => {
    for (const id of CARGO_RESOURCE_TYPES) {
      expect(isSellableResourceType(id)).toBe(true);
    }
  });
  it("rejects unknown ids", () => {
    expect(isSellableResourceType("water")).toBe(false);
    expect(isSellableResourceType("")).toBe(false);
    expect(isSellableResourceType("iron-ore")).toBe(false);
  });
});

describe("sellOps: sellStack", () => {
  it("debits the source stack and reports earned = sold * price", () => {
    const stacks: Partial<Record<(typeof CARGO_RESOURCE_TYPES)[number], number>> = { iron: 10 };
    const result = sellStack({ stacks, id: "iron", amount: 5 });
    expect(result.sold).toBe(5);
    expect(result.earned).toBe(25); // 5 * 5
    expect(result.remaining).toBe(0);
    expect(result.stacks.iron).toBe(5);
  });

  it("caps `sold` at the source's stack when the request exceeds it", () => {
    const stacks: Partial<Record<(typeof CARGO_RESOURCE_TYPES)[number], number>> = { iron: 3 };
    const result = sellStack({ stacks, id: "iron", amount: 10 });
    expect(result.sold).toBe(3);
    expect(result.earned).toBe(15); // 3 * 5
    expect(result.remaining).toBe(7);
    expect(result.stacks.iron).toBeUndefined(); // stack stripped when zero
  });

  it("rejects non-positive amounts (returns the input unchanged)", () => {
    const stacks: Partial<Record<(typeof CARGO_RESOURCE_TYPES)[number], number>> = { iron: 5 };
    expect(sellStack({ stacks, id: "iron", amount: 0 }).sold).toBe(0);
    expect(sellStack({ stacks, id: "iron", amount: -3 }).sold).toBe(0);
  });

  it("does NOT mutate the input stacks map", () => {
    const stacks: Partial<Record<(typeof CARGO_RESOURCE_TYPES)[number], number>> = { iron: 5 };
    const snapshot = JSON.stringify(stacks);
    sellStack({ stacks, id: "iron", amount: 3 });
    expect(JSON.stringify(stacks)).toBe(snapshot);
  });

  it("handles copper and crystal pricing correctly", () => {
    const stacks: Partial<Record<(typeof CARGO_RESOURCE_TYPES)[number], number>> = {
      copper: 4,
      crystal: 2,
    };
    expect(sellStack({ stacks, id: "copper", amount: 2 }).earned).toBe(16); // 2 * 8
    expect(sellStack({ stacks, id: "crystal", amount: 1 }).earned).toBe(60); // 1 * 60
  });
});

describe("sellOps: totalSellable", () => {
  it("sums the inventory + cargo stacks for a single resource", () => {
    const inv: Inventory = { ...emptyInventory(), stacks: { iron: 7 } };
    const cargo: CargoHold = { ...cargoHoldFor("scout"), stacks: { iron: 11 } };
    expect(totalSellable({ inventory: inv, cargo, id: "iron" })).toBe(18);
  });

  it("returns 0 for an empty source", () => {
    expect(
      totalSellable({
        inventory: emptyInventory(),
        cargo: cargoHoldFor("scout"),
        id: "iron",
      }),
    ).toBe(0);
  });
});

describe("sellOps: recomputeCargoWeightAfterSell", () => {
  it("matches the spec math: 1 * iron + 1 * copper + 2 * rare-earths + 3 * crystal", () => {
    const cargo: CargoHold = {
      ...cargoHoldFor("scout"),
      stacks: { iron: 10, copper: 5, "rare-earths": 3, crystal: 2 },
    };
    // 10*1 + 5*1 + 3*2 + 2*3 = 10 + 5 + 6 + 6 = 27
    expect(recomputeCargoWeightAfterSell(cargo)).toBe(27);
  });

  it("clamps to the cargo capacity", () => {
    const cargo: CargoHold = {
      ...cargoHoldFor("scout"),
      stacks: { iron: 9999 },
    };
    expect(recomputeCargoWeightAfterSell(cargo)).toBe(cargo.capacity); // 40 for scout
  });
});

describe("sellOps: recomputeInventoryWeightAfterSell", () => {
  it("matches the spec math for the on-foot inventory", () => {
    const inv: Inventory = {
      stacks: { iron: 20, copper: 5, "rare-earths": 3, crystal: 2 },
      weightUsed: 27,
    };
    expect(recomputeInventoryWeightAfterSell(inv)).toBe(37);
  });
});
