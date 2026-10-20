/**
 * vitals (TASK-51) — hull/shield bar ratio + 300 ms hit-flash timing.
 */
import { describe, expect, it } from "vitest";

import {
  HIT_FLASH_MS,
  HitFlashController,
  hullFillColor,
  shieldFillColor,
  shouldFlashSelfHit,
  vitalsRatio,
} from "./vitals.js";

describe("vitalsRatio", () => {
  it("clamps to [0, 1]", () => {
    expect(vitalsRatio(50, 100)).toBe(0.5);
    expect(vitalsRatio(-1, 100)).toBe(0);
    expect(vitalsRatio(200, 100)).toBe(1);
  });
  it("collapses on non-positive or non-finite max", () => {
    expect(vitalsRatio(50, 0)).toBe(0);
    expect(vitalsRatio(50, -10)).toBe(0);
    expect(vitalsRatio(50, Number.NaN)).toBe(0);
    expect(vitalsRatio(Number.NaN, 100)).toBe(0);
  });
});

describe("HitFlashController — 300 ms window", () => {
  it("flashes for 0..HIT_FLASH_MS ms after a self hit (fake clock)", () => {
    const c = new HitFlashController();
    c.recordSelfHit(1_000);
    expect(c.isFlashing(1_000)).toBe(true);
    expect(c.isFlashing(1_000 + HIT_FLASH_MS - 1)).toBe(true);
    expect(c.isFlashing(1_000 + HIT_FLASH_MS)).toBe(false);
  });
  it("extends the window on a fresh hit during the flash", () => {
    const c = new HitFlashController();
    c.recordSelfHit(1_000);
    c.recordSelfHit(1_200);
    expect(c.isFlashing(1_200 + HIT_FLASH_MS - 1)).toBe(true);
    expect(c.isFlashing(1_200 + HIT_FLASH_MS)).toBe(false);
  });
  it("rejects non-finite timestamps", () => {
    const c = new HitFlashController();
    c.recordSelfHit(Number.NaN);
    expect(c.isFlashing(0)).toBe(false);
  });
  it("returns no flash after reset", () => {
    const c = new HitFlashController();
    c.recordSelfHit(1_000);
    c.reset();
    expect(c.isFlashing(1_000)).toBe(false);
  });
});

describe("shouldFlashSelfHit", () => {
  it("triggers on hit / damaged events targeting self", () => {
    expect(shouldFlashSelfHit("hit", "entity:me", "entity:me")).toBe(true);
    expect(shouldFlashSelfHit("damaged", "entity:me", "entity:me")).toBe(true);
  });
  it("rejects non-self targets", () => {
    expect(shouldFlashSelfHit("hit", "entity:other", "entity:me")).toBe(false);
  });
  it("rejects non-hit / non-damaged events", () => {
    expect(shouldFlashSelfHit("destroyed", "entity:me", "entity:me")).toBe(false);
    expect(shouldFlashSelfHit("kill", "entity:me", "entity:me")).toBe(false);
  });
  it("rejects events with no resolved self id", () => {
    expect(shouldFlashSelfHit("hit", "entity:me", null)).toBe(false);
  });
});

describe("shieldFillColor", () => {
  it("renders full blue when shields are above 35 %", () => {
    expect(shieldFillColor(1.0)).toBe("#7cc7ff");
    expect(shieldFillColor(0.5)).toBe("#7cc7ff");
  });
  it("renders amber when shields are below 35 %", () => {
    expect(shieldFillColor(0.2)).toBe("#f5b94d");
  });
  it("renders red when shields are below 10 %", () => {
    expect(shieldFillColor(0.05)).toBe("#d04848");
  });
  it("renders dark grey when empty", () => {
    expect(shieldFillColor(0)).toBe("#3a3f4d");
  });
});

describe("hullFillColor", () => {
  it("renders amber across all non-empty bands", () => {
    expect(hullFillColor(1.0)).toBe("#f5b94d");
    expect(hullFillColor(0.5)).toBe("#f5b94d");
  });
  it("renders red when hull is below 10 %", () => {
    expect(hullFillColor(0.05)).toBe("#d04848");
  });
  it("renders dark grey when empty", () => {
    expect(hullFillColor(0)).toBe("#3a3f4d");
  });
  it("rejects non-finite input", () => {
    expect(hullFillColor(Number.NaN)).toBe("#3a3f4d");
  });
});
