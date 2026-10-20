/**
 * Weapon / energy readout math — TASK-50 acceptance
 * (energy bar states + loadout counts + missile count).
 */
import { describe, expect, it } from "vitest";

import { ENERGY_MAX } from "@shared/weapons.js";
import {
  ENERGY_AMBER_RATIO,
  ENERGY_LOW_RATIO,
  LOW_ENERGY_LABEL,
  energyBarState,
  loadoutCountLabel,
  missileCountFor,
  weaponLabel,
  weaponSlots,
} from "./energy.js";

describe("energyBarState (TASK-50)", () => {
  it("reads green above the amber threshold", () => {
    const s = energyBarState(100);
    expect(s.level).toBe("ok");
    expect(s.ratio).toBe(1);
    expect(s.lowEnergy).toBe(false);
  });

  it("reads amber below 25 and red below 10 (spec thresholds)", () => {
    expect(energyBarState(ENERGY_MAX * ENERGY_AMBER_RATIO + 1).level).toBe("ok");
    expect(energyBarState(ENERGY_MAX * ENERGY_AMBER_RATIO - 1).level).toBe("amber");
    expect(energyBarState(ENERGY_MAX * ENERGY_LOW_RATIO + 1).level).toBe("amber");
    expect(energyBarState(ENERGY_MAX * ENERGY_LOW_RATIO - 1).level).toBe("red");
  });

  it("surfaces LOW ENERGY only in the red band", () => {
    expect(energyBarState(9).lowEnergy).toBe(true);
    expect(energyBarState(9).color).toBe("#d04848");
    expect(energyBarState(20).lowEnergy).toBe(false);
    expect(LOW_ENERGY_LABEL).toBe("LOW ENERGY");
  });

  it("clamps out-of-range and non-finite energy", () => {
    expect(energyBarState(500).energy).toBe(ENERGY_MAX);
    expect(energyBarState(-10).energy).toBe(0);
    expect(energyBarState(Number.NaN).energy).toBe(0);
  });
});

describe("weapon selector (TASK-50)", () => {
  it("labels the two weapons as the spec pins them", () => {
    expect(weaponLabel("laser")).toBe("LASER");
    expect(weaponLabel("missile")).toBe("MISSILE");
    const slots = weaponSlots("interceptor");
    expect(slots.map((s) => s.key)).toEqual([1, 2]);
    expect(slots.map((s) => s.weapon)).toEqual(["laser", "missile"]);
  });

  it("shows loadout counts — 2x for dual lasers, bay count for missiles", () => {
    expect(loadoutCountLabel("laser", "interceptor")).toBe("2x");
    expect(loadoutCountLabel("missile", "interceptor")).toBe("4");
    expect(loadoutCountLabel("laser", "scout")).toBe("1");
    expect(loadoutCountLabel("missile", "scout")).toBe("0");
  });

  it("marks an unarmed slot unavailable", () => {
    const slots = weaponSlots("scout");
    expect(slots[0]!.available).toBe(true);
    expect(slots[1]!.available).toBe(false);
  });
});

describe("missileCountFor (TASK-50)", () => {
  it("returns null unless the missile weapon is active", () => {
    expect(missileCountFor("laser", 4)).toBeNull();
    expect(missileCountFor("missile", 4)).toBe(4);
    expect(missileCountFor("missile", null)).toBe(0);
    expect(missileCountFor("missile", -2)).toBe(0);
  });
});
