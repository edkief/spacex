/**
 * On-foot inventory operations — unit tests (TASK-34).
 *
 * Covers:
 *   - Empty inventory + recompute weight = 0
 *   - Add to inventory (iron, copper, rare-earths, crystal)
 *   - Weight cap enforcement (partial pickup at the boundary)
 *   - Remove from inventory (drop / give-up)
 *   - Drop validation: amount > owned → remaining > 0 (caller rejects)
 *   - Validator: well-formed round-trip; malformed shapes return false
 *   - Determinism: same input → same output (no hidden state)
 *   - Drop then re-pickup round-trip
 *   - Persistence round-trip via JSON.stringify / parse (proves the
 *     wire shape survives a save/load cycle, required by the
 *     "restart preserves inventory" acceptance criterion).
 */
import { describe, expect, it } from "vitest";

import {
  INVENTORY_RESOURCE_TYPES,
  INVENTORY_WEIGHT_CAP,
  INVENTORY_WEIGHT_PER_UNIT,
  type InventoryResourceType,
} from "./inventory.js";
import {
  addToInventory,
  emptyInventory,
  recomputeWeight,
  removeFromInventory,
  validateInventory,
  weightPerUnit,
} from "./inventoryOps.js";

describe("emptyInventory", () => {
  it("returns an empty shape with zero weight", () => {
    const inv = emptyInventory();
    expect(inv.stacks).toEqual({});
    expect(inv.weightUsed).toBe(0);
  });

  it("is deterministic — two factories are equal", () => {
    expect(emptyInventory()).toEqual(emptyInventory());
  });
});

describe("weightPerUnit + recomputeWeight", () => {
  it("returns the per-unit weights defined in the catalog", () => {
    expect(weightPerUnit("iron")).toBe(1);
    expect(weightPerUnit("copper")).toBe(1);
    expect(weightPerUnit("rare-earths")).toBe(2);
    expect(weightPerUnit("crystal")).toBe(3);
  });

  it("matches the constants exported from inventory.ts", () => {
    for (const id of INVENTORY_RESOURCE_TYPES) {
      expect(weightPerUnit(id)).toBe(INVENTORY_WEIGHT_PER_UNIT[id]);
    }
  });

  it("computes a mixed-stack weight", () => {
    expect(
      recomputeWeight({
        iron: 10,
        crystal: 5,
      }),
    ).toBe(10 * 1 + 5 * 3);
  });

  it("ignores unknown ids (defensive)", () => {
    expect(
      recomputeWeight({ iron: 10, banana: 100 } as unknown as Partial<
        Record<InventoryResourceType, number>
      >),
    ).toBe(10);
  });
});

describe("addToInventory", () => {
  it("adds partial stacks within the cap", () => {
    const inv0 = emptyInventory();
    const r = addToInventory(inv0, "iron", 20);
    expect(r.taken).toBe(20);
    expect(r.remaining).toBe(0);
    expect(r.inventory.stacks.iron).toBe(20);
    expect(r.inventory.weightUsed).toBe(20);
  });

  it("stacks on top of an existing entry", () => {
    const r1 = addToInventory(emptyInventory(), "copper", 5);
    const r2 = addToInventory(r1.inventory, "copper", 7);
    expect(r2.taken).toBe(7);
    expect(r2.inventory.stacks.copper).toBe(12);
    expect(r2.inventory.weightUsed).toBe(12);
  });

  it("truncates a pickup at the weight cap (partial pickup at the boundary)", () => {
    // iron weighs 1 each; cap is 40. A pickup of 100 with 30 weight
    // already used yields capInUnits = (40-30)/1 = 10 taken; 90 left.
    const r1 = addToInventory(emptyInventory(), "iron", 30);
    const r2 = addToInventory(r1.inventory, "iron", 100);
    expect(r2.taken).toBe(10);
    expect(r2.remaining).toBe(90);
    expect(r2.inventory.stacks.iron).toBe(40);
    expect(r2.inventory.weightUsed).toBe(40);
  });

  it("rejects crystal pickup when crystal's weight-unit exceeds remaining cap", () => {
    // crystal weighs 3 each. With 38 weight used only one crystal fits.
    const r1 = addToInventory(emptyInventory(), "iron", 38);
    const r2 = addToInventory(r1.inventory, "crystal", 5);
    expect(r2.taken).toBe(0);
    expect(r2.remaining).toBe(5);
    expect(r2.inventory.stacks.crystal).toBeUndefined();
    expect(r2.inventory.weightUsed).toBe(38);
  });

  it("returns zero taken for a non-positive amount", () => {
    const r1 = addToInventory(emptyInventory(), "iron", 0);
    expect(r1.taken).toBe(0);
    expect(r1.remaining).toBe(0);
    expect(r1.inventory.weightUsed).toBe(0);
    const r2 = addToInventory(emptyInventory(), "iron", -3);
    expect(r2.taken).toBe(0);
    expect(r2.remaining).toBe(-3);
  });

  it("returns zero taken for an unknown resource id", () => {
    const r1 = addToInventory(emptyInventory(), "banana" as unknown as InventoryResourceType, 5);
    expect(r1.taken).toBe(0);
    expect(r1.remaining).toBe(5);
    expect(r1.inventory).toEqual(emptyInventory());
  });

  it("preserves the input inventory (immutability)", () => {
    const inv0 = emptyInventory();
    const snapshot = JSON.stringify(inv0);
    addToInventory(inv0, "iron", 10);
    expect(JSON.stringify(inv0)).toBe(snapshot);
  });
});

describe("removeFromInventory", () => {
  it("removes owned units and lowers the weight", () => {
    const r1 = addToInventory(emptyInventory(), "iron", 20);
    const r2 = removeFromInventory(r1.inventory, "iron", 5);
    expect(r2.taken).toBe(5);
    expect(r2.remaining).toBe(0);
    expect(r2.inventory.stacks.iron).toBe(15);
    expect(r2.inventory.weightUsed).toBe(15);
  });

  it("drops the stack entry when the count hits zero", () => {
    const r1 = addToInventory(emptyInventory(), "copper", 3);
    const r2 = removeFromInventory(r1.inventory, "copper", 3);
    expect(r2.taken).toBe(3);
    expect(r2.inventory.stacks.copper).toBeUndefined();
    expect(r2.inventory.weightUsed).toBe(0);
  });

  it("clamps the drop to the owned amount; remaining is non-zero on over-drop", () => {
    const r1 = addToInventory(emptyInventory(), "crystal", 2);
    const r2 = removeFromInventory(r1.inventory, "crystal", 5);
    expect(r2.taken).toBe(2);
    expect(r2.remaining).toBe(3);
    expect(r2.inventory.stacks.crystal).toBeUndefined();
    expect(r2.inventory.weightUsed).toBe(0);
  });

  it("returns zero taken for an unknown resource id", () => {
    const r1 = addToInventory(emptyInventory(), "iron", 5);
    const r2 = removeFromInventory(r1.inventory, "banana" as unknown as InventoryResourceType, 2);
    expect(r2.taken).toBe(0);
    expect(r2.remaining).toBe(2);
    expect(r2.inventory).toEqual(r1.inventory);
  });

  it("rejects a non-positive drop amount", () => {
    const r1 = addToInventory(emptyInventory(), "iron", 5);
    const r2 = removeFromInventory(r1.inventory, "iron", 0);
    expect(r2.taken).toBe(0);
    expect(r2.remaining).toBe(0);
    expect(r2.inventory).toEqual(r1.inventory);
  });
});

describe("drop and re-pickup round-trip", () => {
  it("survives drop, recompute, re-pickup without drift", () => {
    let inv = emptyInventory();
    // Carry 10 iron + 4 crystal.
    let r = addToInventory(inv, "iron", 10);
    inv = r.inventory;
    r = addToInventory(inv, "crystal", 4);
    inv = r.inventory;
    expect(inv.weightUsed).toBe(22);

    // Drop half the iron.
    r = removeFromInventory(inv, "iron", 5);
    inv = r.inventory;
    expect(inv.stacks.iron).toBe(5);
    expect(inv.weightUsed).toBe(5 + 12);

    // Persist + reload via JSON.
    const wire = JSON.parse(JSON.stringify(inv));
    expect(validateInventory(wire)).toBe(true);
    const reloaded = wire as unknown as typeof inv;
    expect(reloaded).toEqual(inv);

    // Re-pickup the dropped iron (drop server-side mirrors this back into
    // the player inventory — TASK-34 acceptance).
    r = addToInventory(reloaded, "iron", 5);
    inv = r.inventory;
    expect(inv.stacks.iron).toBe(10);
    expect(inv.weightUsed).toBe(22);
  });
});

describe("validateInventory", () => {
  it("accepts the empty inventory", () => {
    expect(validateInventory(emptyInventory())).toBe(true);
    expect(validateInventory({ stacks: {}, weightUsed: 0 })).toBe(true);
  });

  it("accepts a well-formed round-trip", () => {
    const inv = addToInventory(emptyInventory(), "crystal", 10).inventory;
    const wire = JSON.parse(JSON.stringify(inv));
    expect(validateInventory(wire)).toBe(true);
  });

  it("rejects a weight mismatch between stacks and weightUsed", () => {
    expect(validateInventory({ stacks: { iron: 10 }, weightUsed: 99 })).toBe(false);
  });

  it("rejects unknown resource ids", () => {
    expect(validateInventory({ stacks: { banana: 5 } as never, weightUsed: 0 })).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(validateInventory({ stacks: { iron: -1 }, weightUsed: 0 })).toBe(false);
  });

  it("rejects a weight that escapes the cap", () => {
    expect(validateInventory({ stacks: {}, weightUsed: INVENTORY_WEIGHT_CAP + 1 })).toBe(false);
  });

  it("rejects non-finite weight", () => {
    expect(validateInventory({ stacks: {}, weightUsed: Number.NaN })).toBe(false);
  });
});
