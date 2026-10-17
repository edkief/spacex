/**
 * Unit tests for the shared damage math (TASK-23).
 *
 * Covers the acceptance criteria checklist:
 *
 *   - **Shield-first ordering** — including exact boundary cases
 *     (amount == shields, amount == shields + 1, amount == shields
 *     + hull, overkill past shields + hull).
 *   - **Double-destroy guard** — applying damage to an already-
 *     destroyed entity does not re-emit hullHit, does not mutate
 *     HP, still reports `destroyed: true`.
 *   - **Source attribution** — the result is independent of the
 *     source (the function is pure w.r.t. the attribution); the
 *     caller is responsible for embedding `source` into the wire
 *     payload.
 *   - **Non-positive damage** — zero / negative / NaN are no-ops
 *     (except for the already-destroyed flag, which still reports
 *     truthfully).
 *   - **Repair cost table** — `repairCost` returns expected numbers
 *     for full / partial / empty HP across all three classes.
 *
 * The tests are deliberately exhaustive on the boundary cases
 * because the math is the foundation for the live wire protocol —
 * a regression here would silently corrupt the combat HUD.
 */
import { describe, expect, it } from "vitest";

import { applyDamage, repairCost, type DamageSource } from "./damage.js";
import { SHIP_CLASSES } from "../ships.js";

const ATTACKER: DamageSource = { kind: "player", id: "attacker-1" };
const NPC: DamageSource = { kind: "ai", id: "rogue-1" };

// ---------------------------------------------------------------------------
// applyDamage — shield-first ordering
// ---------------------------------------------------------------------------

describe("applyDamage — shield-first ordering", () => {
  it("absorbs entirely into shields when amount < shields", () => {
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: 30,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(30);
    expect(out.hullHit).toBe(0);
    expect(out.destroyed).toBe(false);
    expect(out.newShields).toBe(20);
    expect(out.newHull).toBe(100);
  });

  it("absorbs exactly into shields at the boundary (amount == shields)", () => {
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: 50,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(50);
    expect(out.hullHit).toBe(0);
    expect(out.destroyed).toBe(false);
    expect(out.newShields).toBe(0);
    expect(out.newHull).toBe(100);
  });

  it("overflows one HP to hull at amount == shields + 1", () => {
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: 51,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(50);
    expect(out.hullHit).toBe(1);
    expect(out.destroyed).toBe(false);
    expect(out.newShields).toBe(0);
    expect(out.newHull).toBe(99);
  });

  it("destroys at the exact-kill boundary (amount == shields + hull)", () => {
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: 150,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(50);
    expect(out.hullHit).toBe(100);
    expect(out.destroyed).toBe(true);
    expect(out.newShields).toBe(0);
    expect(out.newHull).toBe(0);
  });

  it("drops overkill silently (amount > shields + hull)", () => {
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: 9_999,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(50);
    expect(out.hullHit).toBe(100);
    expect(out.destroyed).toBe(true);
    expect(out.newShields).toBe(0);
    expect(out.newHull).toBe(0);
  });

  it("works identically when called with the source kind set to 'ai'", () => {
    // The math is identical regardless of source — this guards against
    // an accidental dependence on `source.kind`.
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: 150,
      source: NPC,
    });
    expect(out.shieldHit).toBe(50);
    expect(out.hullHit).toBe(100);
    expect(out.destroyed).toBe(true);
  });

  it("clamps shields if the caller passes a value above maxShields", () => {
    // Defensive: a future buff or a buggy state restore could leave
    // shields above the class max. `applyDamage` should clamp on the
    // way in so the result stays within `[0, max]`.
    const out = applyDamage({
      target: { hull: 100, shields: 999 },
      classId: "scout",
      amount: 30,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(30); // clamped to max 50 first
    expect(out.newShields).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// applyDamage — double-destroy guard
// ---------------------------------------------------------------------------

describe("applyDamage — double-destroy guard", () => {
  it("returns destroyed:true on an already-destroyed target without re-hitting hull", () => {
    const out = applyDamage({
      target: { hull: 0, shields: 0 },
      classId: "scout",
      amount: 25,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(0);
    expect(out.hullHit).toBe(0);
    expect(out.destroyed).toBe(true);
    expect(out.newHull).toBe(0);
    expect(out.newShields).toBe(0);
  });

  it("returns destroyed:true for hull > 0 if shields are already at zero (hull still alive)", () => {
    // Sanity: shields can be zero while hull is healthy. applyDamage
    // does not mistakenly call that "destroyed" — only hull==0 does.
    const out = applyDamage({
      target: { hull: 100, shields: 0 },
      classId: "scout",
      amount: 10,
      source: ATTACKER,
    });
    expect(out.destroyed).toBe(false);
    expect(out.newHull).toBe(90);
    expect(out.newShields).toBe(0);
  });

  it("repeated calls do not compound damage past the kill", () => {
    // Two hits totalling S+H are a kill. A third hit must NOT carry
    // shieldHit or hullHit — the double-destroy guard is what makes
    // the broadcast loop idempotent.
    const first = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: 150,
      source: ATTACKER,
    });
    expect(first.destroyed).toBe(true);
    const second = applyDamage({
      target: { hull: first.newHull, shields: first.newShields },
      classId: "scout",
      amount: 25,
      source: ATTACKER,
    });
    expect(second.shieldHit).toBe(0);
    expect(second.hullHit).toBe(0);
    expect(second.destroyed).toBe(true);
    expect(second.newHull).toBe(0);
    expect(second.newShields).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyDamage — degenerate inputs
// ---------------------------------------------------------------------------

describe("applyDamage — non-positive and non-finite damage", () => {
  it("treats zero amount as a no-op (HP unchanged)", () => {
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: 0,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(0);
    expect(out.hullHit).toBe(0);
    expect(out.destroyed).toBe(false);
    expect(out.newShields).toBe(50);
    expect(out.newHull).toBe(100);
  });

  it("treats negative amount as a no-op (HP unchanged)", () => {
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: -25,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(0);
    expect(out.hullHit).toBe(0);
    expect(out.destroyed).toBe(false);
  });

  it("treats NaN as a no-op (HP unchanged)", () => {
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: NaN,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(0);
    expect(out.hullHit).toBe(0);
    expect(out.destroyed).toBe(false);
  });

  it("treats Infinity as a no-op (HP unchanged)", () => {
    const out = applyDamage({
      target: { hull: 100, shields: 50 },
      classId: "scout",
      amount: Number.POSITIVE_INFINITY,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(0);
    expect(out.hullHit).toBe(0);
    expect(out.destroyed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyDamage — class coverage
// ---------------------------------------------------------------------------

describe("applyDamage — class coverage", () => {
  it("uses freighter maxes (hull=200, shields=80)", () => {
    const cls = SHIP_CLASSES.freighter;
    const out = applyDamage({
      target: { hull: cls.hull, shields: cls.shieldCapacity },
      classId: "freighter",
      amount: 280,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(80);
    expect(out.hullHit).toBe(200);
    expect(out.destroyed).toBe(true);
    expect(out.newHull).toBe(0);
  });

  it("uses interceptor maxes (hull=80, shields=40)", () => {
    const cls = SHIP_CLASSES.interceptor;
    const out = applyDamage({
      target: { hull: cls.hull, shields: cls.shieldCapacity },
      classId: "interceptor",
      amount: 120,
      source: ATTACKER,
    });
    expect(out.shieldHit).toBe(40);
    expect(out.hullHit).toBe(80);
    expect(out.destroyed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// repairCost — table
// ---------------------------------------------------------------------------

describe("repairCost — table", () => {
  it("returns 0 for a fully repaired ship", () => {
    expect(repairCost({ hull: 100, shields: 50 }, "scout")).toBe(0);
  });

  it("returns ceil(10) + ceil(5) = 15 for a fully wrecked scout", () => {
    expect(repairCost({ hull: 0, shields: 0 }, "scout")).toBe(15);
  });

  it("returns 0 for a fully repaired freighter", () => {
    const cls = SHIP_CLASSES.freighter;
    expect(repairCost({ hull: cls.hull, shields: cls.shieldCapacity }, "freighter")).toBe(0);
  });

  it("returns 15 for a fully wrecked freighter", () => {
    // 200 hull + 80 shields → ceil(10) + ceil(5) = 15 regardless of
    // class. The formula is fixed at 10 hull-points + 5 shield-points.
    expect(repairCost({ hull: 0, shields: 0 }, "freighter")).toBe(15);
  });

  it("returns 15 for a fully wrecked interceptor", () => {
    expect(repairCost({ hull: 0, shields: 0 }, "interceptor")).toBe(15);
  });

  it("computes partial-hull partial-shield cost for scout", () => {
    // hull=50 (50% missing on a 100 hull) → ceil(0.5 * 10) = 5
    // shields=25 (50% missing on a 50 shield) → ceil(0.5 * 5) = 3
    expect(repairCost({ hull: 50, shields: 25 }, "scout")).toBe(8);
  });

  it("computes hull-only damage cost for scout (shields full)", () => {
    // hull=10 (90% missing on a 100 hull) → ceil(0.9 * 10) = 9
    // shields=50 (full) → 0
    expect(repairCost({ hull: 10, shields: 50 }, "scout")).toBe(9);
  });

  it("computes shield-only damage cost for scout (hull full)", () => {
    // hull=100 (full) → 0
    // shields=10 (80% missing on a 50 shield) → ceil(0.8 * 5) = 4
    expect(repairCost({ hull: 100, shields: 10 }, "scout")).toBe(4);
  });

  it("returns non-negative even if shields somehow exceed maxShields", () => {
    // Future buff left shields at 999. The cost formula should clamp
    // gracefully: the shield term goes negative, but Math.max(0, …)
    // keeps the bill non-negative.
    expect(repairCost({ hull: 100, shields: 999 }, "scout")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Repair cost — every (hull, shield) cell in a tiny grid
// ---------------------------------------------------------------------------

describe("repairCost — boundary micro-grid", () => {
  // Confirms the ceil rounding at every tenth of a hull point + every
  // fifth of a shield point. Defensive: if someone tweaks the formula
  // and forgets to re-evaluate the ceiling, this surfaces it.

  it("hull=99 → ceil(0.01 * 10) = 1 (hull term only)", () => {
    expect(repairCost({ hull: 99, shields: 50 }, "scout")).toBe(1);
  });

  it("hull=90 → ceil(0.10 * 10) = 1", () => {
    expect(repairCost({ hull: 90, shields: 50 }, "scout")).toBe(1);
  });

  it("hull=89 → ceil(0.11 * 10) = 2", () => {
    expect(repairCost({ hull: 89, shields: 50 }, "scout")).toBe(2);
  });

  it("shields=49 → ceil(0.02 * 5) = 1", () => {
    expect(repairCost({ hull: 100, shields: 49 }, "scout")).toBe(1);
  });

  it("shields=40 → ceil(0.20 * 5) = 1", () => {
    expect(repairCost({ hull: 100, shields: 40 }, "scout")).toBe(1);
  });

  it("shields=39 → ceil(0.22 * 5) = 2", () => {
    expect(repairCost({ hull: 100, shields: 39 }, "scout")).toBe(2);
  });
});
