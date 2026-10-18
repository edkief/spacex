/**
 * Resource catalog tests — TASK-37.
 *
 * Validates:
 *   - Catalog shape (4 entries, exact weight + basePrice per resource)
 *   - Selection-weight sum = 1.0
 *   - `pickResource(rng)` distribution roughly matches weights
 *   - `isResourceId` / `resourceWeight` / `resourceBasePrice` helpers
 *
 * Pure unit suite — no DB, no network, no node-specific APIs.
 */
import { describe, expect, it } from "vitest";

import { Rng } from "./random.js";
import {
  isResourceId,
  pickResource,
  RESOURCE_CATALOG,
  RESOURCE_IDS,
  RESOURCE_ID_SET,
  RESOURCE_WEIGHTS,
  RESOURCE_WEIGHT_SUM,
  resourceBasePrice,
  resourceEntry,
  resourceWeight,
  type ResourceId,
} from "./resources.js";

describe("RESOURCE_CATALOG", () => {
  it("contains exactly the four v1 deposit resources", () => {
    expect(Object.keys(RESOURCE_CATALOG).sort()).toEqual([
      "copper",
      "crystal",
      "iron",
      "rare-earths",
    ]);
    expect(RESOURCE_IDS).toEqual(["iron", "copper", "rare-earths", "crystal"]);
  });

  it("matches the spec weights + base prices", () => {
    expect(RESOURCE_CATALOG.iron.weight).toBe(1);
    expect(RESOURCE_CATALOG.iron.basePrice).toBe(5);
    expect(RESOURCE_CATALOG.copper.weight).toBe(1);
    expect(RESOURCE_CATALOG.copper.basePrice).toBe(8);
    expect(RESOURCE_CATALOG["rare-earths"].weight).toBe(2);
    expect(RESOURCE_CATALOG["rare-earths"].basePrice).toBe(25);
    expect(RESOURCE_CATALOG.crystal.weight).toBe(3);
    expect(RESOURCE_CATALOG.crystal.basePrice).toBe(60);
  });
});

describe("RESOURCE_WEIGHTS", () => {
  it("sums to 1.0 within float tolerance", () => {
    expect(RESOURCE_WEIGHT_SUM).toBeCloseTo(1.0, 6);
  });

  it("matches the spec distribution (iron 40, copper 30, rare-earths 20, crystal 10)", () => {
    expect(RESOURCE_WEIGHTS.iron).toBeCloseTo(0.4, 6);
    expect(RESOURCE_WEIGHTS.copper).toBeCloseTo(0.3, 6);
    expect(RESOURCE_WEIGHTS["rare-earths"]).toBeCloseTo(0.2, 6);
    expect(RESOURCE_WEIGHTS.crystal).toBeCloseTo(0.1, 6);
  });
});

describe("isResourceId", () => {
  it("narrows valid ids", () => {
    for (const id of RESOURCE_IDS) {
      expect(isResourceId(id)).toBe(true);
    }
  });

  it("rejects unknown ids", () => {
    expect(isResourceId("platinum")).toBe(false);
    expect(isResourceId("")).toBe(false);
    expect(isResourceId("IRON")).toBe(false);
    expect(isResourceId("rare-earth")).toBe(false); // not the catalog spelling
  });

  it("mirrors the set membership", () => {
    for (const id of RESOURCE_IDS) {
      expect(RESOURCE_ID_SET.has(id)).toBe(true);
    }
    expect(RESOURCE_ID_SET.size).toBe(RESOURCE_IDS.length);
  });
});

describe("resourceEntry / resourceWeight / resourceBasePrice", () => {
  it("returns the matching catalog row", () => {
    expect(resourceEntry("iron")).toBe(RESOURCE_CATALOG.iron);
    expect(resourceEntry("crystal")).toBe(RESOURCE_CATALOG.crystal);
  });

  it("returns the per-unit weight", () => {
    expect(resourceWeight("iron")).toBe(1);
    expect(resourceWeight("copper")).toBe(1);
    expect(resourceWeight("rare-earths")).toBe(2);
    expect(resourceWeight("crystal")).toBe(3);
  });

  it("returns the dock sell price", () => {
    expect(resourceBasePrice("iron")).toBe(5);
    expect(resourceBasePrice("copper")).toBe(8);
    expect(resourceBasePrice("rare-earths")).toBe(25);
    expect(resourceBasePrice("crystal")).toBe(60);
  });
});

describe("pickResource", () => {
  it("always returns a known id", () => {
    const rng = new Rng(0x1234_5678n);
    for (let i = 0; i < 1_000; i++) {
      const id = pickResource(rng);
      expect(RESOURCE_IDS).toContain(id);
    }
  });

  it("is deterministic for a fixed seed", () => {
    const rng1 = new Rng(42n);
    const rng2 = new Rng(42n);
    const draws1: ResourceId[] = [];
    const draws2: ResourceId[] = [];
    for (let i = 0; i < 200; i++) {
      draws1.push(pickResource(rng1));
      draws2.push(pickResource(rng2));
    }
    expect(draws1).toEqual(draws2);
  });

  it("approximately matches the weight distribution over many draws", () => {
    const rng = new Rng(0x9e3779b9_7f4a7c15n);
    const counts: Record<ResourceId, number> = {
      iron: 0,
      copper: 0,
      "rare-earths": 0,
      crystal: 0,
    };
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const id = pickResource(rng);
      counts[id]++;
    }
    // Allow ±2 percentage points tolerance per category.
    expect(counts.iron / N).toBeCloseTo(RESOURCE_WEIGHTS.iron, 1);
    expect(counts.copper / N).toBeCloseTo(RESOURCE_WEIGHTS.copper, 1);
    expect(counts["rare-earths"] / N).toBeCloseTo(RESOURCE_WEIGHTS["rare-earths"], 1);
    expect(counts.crystal / N).toBeCloseTo(RESOURCE_WEIGHTS.crystal, 1);
    // Counts sum to N.
    expect(counts.iron + counts.copper + counts["rare-earths"] + counts.crystal).toBe(N);
  });
});
