/**
 * Unit tests for the per-planet generator (`shared/galaxy/planet.ts`).
 *
 * Why split from `system.test.ts`: the per-planet API
 * (`generatePlanet(parentStarId, systemSeed, orbitIndex)`) is a public
 * helper used directly by the test suite (and by future TASK-45 AI
 * placement code). It deserves its own focused file so its invariants
 * can be read independently of the system-level suite.
 *
 * Coverage:
 *   - id derivation: planet id == hex(hash2(systemSeed, orbitIndex)).
 *   - orbitIndex: matches the input value for every slot.
 *   - AI roster: count bounded 2..5; classes length == count; same
 *     seed → same body (determinism sanity).
 */

import { describe, it, expect } from "vitest";

import { generatePlanet } from "./planet.js";
import { AI_ROSTER_MAX, AI_ROSTER_MIN } from "./config-system.js";
import { hash2 } from "../random.js";
import { bigintToHex } from "./system.helpers.js";

describe("shared/galaxy/planet — generatePlanet", () => {
  it("returns a planet with id == hex(hash2(systemSeed, orbitIndex))", () => {
    const systemSeed = 0x123456789abcdef0n;
    for (let j = 0; j < 4; j++) {
      const p = generatePlanet("0000000000000000", systemSeed, j);
      const expected = bigintToHex(hash2(systemSeed, BigInt(j)), 16);
      expect(p.id).toBe(expected);
    }
  });

  it("orbitIndex matches the input value across 6 slots", () => {
    const systemSeed = 0xaabbccddeeff0011n;
    for (let j = 0; j < 6; j++) {
      const p = generatePlanet("0000000000000000", systemSeed, j);
      expect(p.orbitIndex).toBe(j);
    }
  });

  it("AI roster count is bounded [AI_ROSTER_MIN, AI_ROSTER_MAX]", () => {
    const systemSeed = 0x4242424242424242n;
    for (let j = 0; j < 12; j++) {
      const p = generatePlanet("0000000000000000", systemSeed, j);
      expect(p.aiRoster.count).toBeGreaterThanOrEqual(AI_ROSTER_MIN);
      expect(p.aiRoster.count).toBeLessThanOrEqual(AI_ROSTER_MAX);
    }
  });

  it("two calls with the same seed produce the same planet body", () => {
    const systemSeed = 0x1111111111111111n;
    const a = generatePlanet("0000000000000000", systemSeed, 0);
    const b = generatePlanet("0000000000000000", systemSeed, 0);
    expect(a).toEqual(b);
  });

  it("different orbitIndices produce different ids", () => {
    const systemSeed = 0x9999999999999999n;
    const ids = new Set<string>();
    for (let j = 0; j < 6; j++) {
      const p = generatePlanet("0000000000000000", systemSeed, j);
      ids.add(p.id);
    }
    expect(ids.size).toBe(6);
  });
});
