/**
 * Unit tests for `shared/ships` (TASK-19).
 *
 * Coverage:
 *   - `SHIP_CLASSES` shape: exactly 3 entries, every key present,
 *     id matches the key, all stats are positive finite numbers.
 *   - `cargoSlots >= 1` for every class.
 *   - Balance invariants from the spec:
 *       * freighter has the most cargo (cargoSlots + maxWeight).
 *       * freighter has the lowest maxVelocity.
 *       * interceptor has the highest maxVelocity.
 *       * interceptor has the only missile battery.
 *       * scout is the middle starter (mid cargo, mid speed).
 *       * prices ascending: scout < interceptor < freighter.
 *   - Helpers:
 *       * `shipStats(id)` returns the row; throws on unknown id.
 *       * `totalWeaponCount(id)` sums laser + missiles.
 *       * `shipPrice(id)` returns the price.
 *       * `compareShips(a, b, key)` orders numerically.
 *
 * @see ./ships.ts for the catalog this exercises.
 */

import { describe, it, expect } from "vitest";

import {
  SHIP_CLASSES,
  SHIP_CLASS_IDS,
  compareShips,
  shipPrice,
  shipStats,
  totalWeaponCount,
  type ShipClass,
  type ShipClassId,
  type ShipStatKey,
} from "./ships.js";

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

describe("shared/ships — catalog shape", () => {
  it("exposes exactly the three v1 ship classes", () => {
    expect(SHIP_CLASS_IDS).toEqual(["scout", "freighter", "interceptor"]);
    expect(Object.keys(SHIP_CLASSES).sort()).toEqual([...SHIP_CLASS_IDS].sort());
  });

  it("maps each ShipClassId to a row whose id matches the key", () => {
    for (const id of SHIP_CLASS_IDS) {
      const row = SHIP_CLASSES[id];
      expect(row).toBeDefined();
      expect(row.id).toBe(id);
    }
  });

  it("includes every required field on each class", () => {
    for (const id of SHIP_CLASS_IDS) {
      const row = SHIP_CLASSES[id];
      // Spot-check the field set — every field on ShipClass must be
      // present and not undefined.
      expect(typeof row.id).toBe("string");
      expect(typeof row.name).toBe("string");
      expect(typeof row.description).toBe("string");
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Stat validity (positive finite, cargo >= 1)
// ---------------------------------------------------------------------------

describe("shared/ships — stat validity", () => {
  const NUMERIC_KEYS: ShipStatKey[] = [
    "mass",
    "maxVelocity",
    "acceleration",
    "turnRate",
    "cargoSlots",
    "maxWeight",
    "shieldCapacity",
    "hull",
    "repairCostPerPoint",
    "price",
    "liverySlots",
  ];

  for (const id of SHIP_CLASS_IDS) {
    it(`${id}: every numeric stat is a positive finite number`, () => {
      const row: ShipClass = SHIP_CLASSES[id];
      for (const k of NUMERIC_KEYS) {
        const val = row[k];
        expect(typeof val).toBe("number");
        expect(Number.isFinite(val)).toBe(true);
        // Price is the one stat that is allowed to be zero (the starter
        // scout is 0 credits); every other stat must be strictly positive.
        if (k === "price") {
          expect(val).toBeGreaterThanOrEqual(0);
        } else {
          expect(val).toBeGreaterThan(0);
        }
      }
    });
  }

  it("every class has at least one cargo slot", () => {
    for (const id of SHIP_CLASS_IDS) {
      expect(SHIP_CLASSES[id].cargoSlots).toBeGreaterThanOrEqual(1);
    }
  });

  it("every class has the spec-mandated 3 livery slots (TASK-21)", () => {
    for (const id of SHIP_CLASS_IDS) {
      expect(SHIP_CLASSES[id].liverySlots).toBe(3);
    }
  });

  it("weapon mounts are within the spec-allowed {1|2 laser, 0|4 missile}", () => {
    for (const id of SHIP_CLASS_IDS) {
      const mounts = SHIP_CLASSES[id].weaponMounts;
      expect([1, 2]).toContain(mounts.laser);
      expect([0, 4]).toContain(mounts.missiles);
    }
  });
});

// ---------------------------------------------------------------------------
// Balance invariants
// ---------------------------------------------------------------------------

describe("shared/ships — balance invariants", () => {
  it("freighter has the most cargo slots of the three classes", () => {
    expect(SHIP_CLASSES.freighter.cargoSlots).toBeGreaterThan(SHIP_CLASSES.scout.cargoSlots);
    expect(SHIP_CLASSES.freighter.cargoSlots).toBeGreaterThan(SHIP_CLASSES.interceptor.cargoSlots);
  });

  it("freighter has the largest maxWeight of the three classes", () => {
    expect(SHIP_CLASSES.freighter.maxWeight).toBeGreaterThan(SHIP_CLASSES.scout.maxWeight);
    expect(SHIP_CLASSES.freighter.maxWeight).toBeGreaterThan(SHIP_CLASSES.interceptor.maxWeight);
  });

  it("freighter has the lowest maxVelocity of the three classes", () => {
    expect(SHIP_CLASSES.freighter.maxVelocity).toBeLessThan(SHIP_CLASSES.scout.maxVelocity);
    expect(SHIP_CLASSES.freighter.maxVelocity).toBeLessThan(SHIP_CLASSES.interceptor.maxVelocity);
  });

  it("interceptor has the highest maxVelocity of the three classes", () => {
    expect(SHIP_CLASSES.interceptor.maxVelocity).toBeGreaterThan(SHIP_CLASSES.scout.maxVelocity);
    expect(SHIP_CLASSES.interceptor.maxVelocity).toBeGreaterThan(
      SHIP_CLASSES.freighter.maxVelocity,
    );
  });

  it("interceptor is the only class with a missile battery", () => {
    expect(SHIP_CLASSES.interceptor.weaponMounts.missiles).toBe(4);
    expect(SHIP_CLASSES.scout.weaponMounts.missiles).toBe(0);
    expect(SHIP_CLASSES.freighter.weaponMounts.missiles).toBe(0);
  });

  it("scout is the middle starter (cargo and speed sit between the other two)", () => {
    // Cargo slots: freighter > scout > interceptor (interceptor has 2, scout 4)
    expect(SHIP_CLASSES.freighter.cargoSlots).toBeGreaterThan(SHIP_CLASSES.scout.cargoSlots);
    expect(SHIP_CLASSES.scout.cargoSlots).toBeGreaterThan(SHIP_CLASSES.interceptor.cargoSlots);
    // Speed: interceptor > scout > freighter
    expect(SHIP_CLASSES.interceptor.maxVelocity).toBeGreaterThan(SHIP_CLASSES.scout.maxVelocity);
    expect(SHIP_CLASSES.scout.maxVelocity).toBeGreaterThan(SHIP_CLASSES.freighter.maxVelocity);
  });

  it("prices ascend scout < interceptor < freighter (with scout free)", () => {
    expect(SHIP_CLASSES.scout.price).toBe(0);
    expect(SHIP_CLASSES.interceptor.price).toBeGreaterThan(SHIP_CLASSES.scout.price);
    expect(SHIP_CLASSES.freighter.price).toBeGreaterThan(SHIP_CLASSES.interceptor.price);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("shared/ships — helpers", () => {
  it("shipStats(id) returns the matching row", () => {
    for (const id of SHIP_CLASS_IDS) {
      expect(shipStats(id)).toBe(SHIP_CLASSES[id]);
    }
  });

  it("shipStats(id) throws on an unknown id", () => {
    // Cast through unknown so the test reaches the runtime branch
    // regardless of the public type — we want to prove the runtime
    // guard fires for any id we did not put in the catalog.
    const bogus = "destroyer" as unknown as ShipClassId;
    expect(() => shipStats(bogus)).toThrow(/unknown ship class/i);
  });

  it("shipStats(id) throws on undefined / null / number / boolean", () => {
    expect(() => shipStats(undefined as unknown as ShipClassId)).toThrow();
    expect(() => shipStats(null as unknown as ShipClassId)).toThrow();
    expect(() => shipStats(42 as unknown as ShipClassId)).toThrow();
    expect(() => shipStats(true as unknown as ShipClassId)).toThrow();
  });

  it("totalWeaponCount sums laser + missiles for each class", () => {
    expect(totalWeaponCount("scout")).toBe(1); // 1 laser + 0 missiles
    expect(totalWeaponCount("freighter")).toBe(1); // 1 laser + 0 missiles
    expect(totalWeaponCount("interceptor")).toBe(6); // 2 lasers + 4 missiles
  });

  it("totalWeaponCount throws on unknown id", () => {
    expect(() => totalWeaponCount("yacht" as unknown as ShipClassId)).toThrow();
  });

  it("shipPrice matches shipStats(id).price", () => {
    for (const id of SHIP_CLASS_IDS) {
      expect(shipPrice(id)).toBe(SHIP_CLASSES[id].price);
    }
  });

  it("compareShips returns negative / zero / positive based on key", () => {
    // scout (0) < interceptor (2500) by price
    expect(compareShips("scout", "interceptor", "price")).toBeLessThan(0);
    expect(compareShips("interceptor", "scout", "price")).toBeGreaterThan(0);
    expect(compareShips("scout", "scout", "price")).toBe(0);

    // freighter (60) < interceptor (180) by maxVelocity
    expect(compareShips("freighter", "interceptor", "maxVelocity")).toBeLessThan(0);

    // interceptor (180) > scout (120) by maxVelocity
    expect(compareShips("interceptor", "scout", "maxVelocity")).toBeGreaterThan(0);
  });

  it("compareShips respects the comparator contract (sort is monotonic)", () => {
    // Sort the catalog by price ascending and assert the order matches
    // the spec: scout (0) < interceptor (2500) < freighter (4000).
    const sorted: ShipClassId[] = [...SHIP_CLASS_IDS].sort((a, b) => compareShips(a, b, "price"));
    expect(sorted).toEqual(["scout", "interceptor", "freighter"]);

    // Sort by maxVelocity ascending: freighter < scout < interceptor.
    const bySpeed: ShipClassId[] = [...SHIP_CLASS_IDS].sort((a, b) =>
      compareShips(a, b, "maxVelocity"),
    );
    expect(bySpeed).toEqual(["freighter", "scout", "interceptor"]);
  });
});
