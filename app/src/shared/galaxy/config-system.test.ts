/**
 * Unit tests for the system-generator tunables in
 * `shared/galaxy/config-system.ts`.
 *
 * Kept in its own file (mirroring the upstream `stars.test.ts` →
 * `config.ts` pattern) so the system's functional suite doesn't have
 * to also carry the integer-bound assertions.
 */

import { describe, it, expect } from "vitest";

import {
  AI_ROSTER_MAX,
  AI_ROSTER_MIN,
  ATMOSPHERE_PROBABILITY,
  DOCK_COUNT_MAX,
  DOCK_COUNT_MIN,
  NON_GAS_LANDABLE_PROBABILITY,
  PLANET_CLASS_WEIGHTS,
  PLANET_CLASS_WEIGHT_SUM,
  PLANET_COUNT_MAX,
  PLANET_COUNT_MIN,
  PLANET_NAME_INDEX_MAX,
  PLANET_RADIUS_MAX_KM,
  PLANET_RADIUS_MAX_KM_GAS,
  PLANET_RADIUS_MIN_KM,
  PLANET_RADIUS_MIN_KM_GAS,
  RESOURCE_PICKS_MAX,
  RESOURCE_PICKS_MIN,
  SYSTEM_NAME_SUFFIX,
} from "./config-system.js";
import { PLANET_CLASSES } from "./types.js";

describe("shared/galaxy/config-system — tunables", () => {
  it("PLANET_COUNT bounds are 2..6 (spec range)", () => {
    expect(PLANET_COUNT_MIN).toBe(2);
    expect(PLANET_COUNT_MAX).toBe(6);
    expect(PLANET_COUNT_MAX).toBeGreaterThanOrEqual(PLANET_COUNT_MIN);
  });

  it("PLANET_RADIUS bounds match spec (gas 20k..60k, others 2k..8k)", () => {
    expect(PLANET_RADIUS_MIN_KM).toBe(2_000);
    expect(PLANET_RADIUS_MAX_KM).toBe(8_000);
    expect(PLANET_RADIUS_MIN_KM_GAS).toBe(20_000);
    expect(PLANET_RADIUS_MAX_KM_GAS).toBe(60_000);
    expect(PLANET_RADIUS_MIN_KM_GAS).toBeGreaterThan(PLANET_RADIUS_MAX_KM);
    expect(PLANET_RADIUS_MAX_KM_GAS).toBeGreaterThan(PLANET_RADIUS_MIN_KM_GAS);
  });

  it("planet class weights cover all five classes and sum to 1.0", () => {
    for (const cls of PLANET_CLASSES) {
      expect(PLANET_CLASS_WEIGHTS[cls]).toBeGreaterThan(0);
    }
    expect(Math.abs(PLANET_CLASS_WEIGHT_SUM - 1)).toBeLessThan(1e-9);
  });

  it("atmosphere probabilities are within [0, 1]", () => {
    for (const cls of Object.keys(
      ATMOSPHERE_PROBABILITY,
    ) as (keyof typeof ATMOSPHERE_PROBABILITY)[]) {
      const p = ATMOSPHERE_PROBABILITY[cls];
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("non-gas landable probability is high (>= 0.8) but < 1", () => {
    expect(NON_GAS_LANDABLE_PROBABILITY).toBeGreaterThanOrEqual(0.8);
    expect(NON_GAS_LANDABLE_PROBABILITY).toBeLessThan(1);
  });

  it("dock and roster and resource pick bounds match spec (1..3, 2..5, 1..3)", () => {
    expect(DOCK_COUNT_MIN).toBe(1);
    expect(DOCK_COUNT_MAX).toBe(3);
    expect(AI_ROSTER_MIN).toBe(2);
    expect(AI_ROSTER_MAX).toBe(5);
    expect(RESOURCE_PICKS_MIN).toBe(1);
    expect(RESOURCE_PICKS_MAX).toBe(3);
    expect(PLANET_NAME_INDEX_MAX).toBeGreaterThanOrEqual(PLANET_COUNT_MAX);
  });

  it("system name suffix is ' system'", () => {
    expect(SYSTEM_NAME_SUFFIX).toBe(" system");
  });
});
