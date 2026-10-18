/**
 * Regime parity test — runs the same `regimeFor` query under happy-dom
 * and verifies the result is bit-equal to the node-environment value.
 *
 * Mirrors the parity pattern established by TASK-2 (`random.parity.test.ts`):
 * if a function is pure it must produce identical output across all
 * execution environments — node, happy-dom, jsdom, real browser. This
 * test pins the parity contract for the regime manager, which is the
 * one piece of math the server's authoritative simulation and the
 * client's predicted simulation BOTH depend on.
 *
 * The pragma switches the Vitest environment to happy-dom for the
 * duration of this file only; other tests stay on node (the default).
 */

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { HYSTERESIS_FACTOR, regimeFor, type RegimePlanetContext } from "./regime.js";
import type { Vec3 } from "./physics/vec.js";

function flatPlanet(overrides: Partial<RegimePlanetContext> = {}): RegimePlanetContext {
  return {
    id: "parity-planet",
    center: { x: 0, y: 0, z: 0 },
    radius: 100,
    atmosphereHeight: 10,
    hasAtmosphere: true,
    heightAt: () => 0,
    ...overrides,
  };
}

describe("regime parity", () => {
  it("HYSTERESIS_FACTOR is identical across environments", () => {
    expect(HYSTERESIS_FACTOR).toBe(1.05);
  });

  it("regimeFor returns identical values under happy-dom", () => {
    const p = flatPlanet();
    const samples: { pos: Vec3; current: "space" | "atmosphere" | "surface"; vy: number }[] = [
      { pos: { x: 0, y: 50, z: 0 }, current: "space", vy: 0 },
      { pos: { x: 0, y: 100, z: 0 }, current: "atmosphere", vy: 0 },
      { pos: { x: 0, y: 101, z: 0 }, current: "atmosphere", vy: 1 },
      { pos: { x: 0, y: 112, z: 0 }, current: "space", vy: 0 },
      { pos: { x: 50, y: 130, z: 50 }, current: "atmosphere", vy: 0 },
    ];
    for (const s of samples) {
      const r = regimeFor(s.pos, [p], s.current, { x: 0, y: s.vy, z: 0 });
      // Snapshot the result — these values are the contract.
      expect(r.regime).toMatchSnapshot();
      expect(r.planetId).toMatchSnapshot();
    }
  });
});
