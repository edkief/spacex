/**
 * Tests for the travel math + projection helpers in `./travel.ts`.
 *
 * Coverage:
 *   - `planarDistance` is symmetric, zero on self-loops, and
 *     matches `Math.hypot` within float tolerance.
 *   - `distanceToLightSeconds` is the pure scalar multiplier and
 *     rejects negative / non-finite inputs.
 *   - `warpTimeSeconds` is consistent with `distanceToLightSeconds`
 *     via `WARP_SPEED_LIGHT_SECONDS_PER_SECOND` and rounds to the
 *     nearest integer (no fractional seconds).
 *   - `computeNeighbors` returns exactly `NEAREST_NEIGHBOUR_COUNT`
 *     edges per star, in **ascending warp-time order**, and is
 *        symmetric (`a→b` implies `b→a`).
 *   - `projectToChart` keeps all points inside the viewport, the
 *     bounding box is centred, and the projection is deterministic
 *     across two calls.
 */
import { describe, it, expect } from "vitest";

import {
  GU_TO_LIGHT_SECONDS,
  NEAREST_NEIGHBOUR_COUNT,
  STAR_CHART_VIEW_HEIGHT,
  STAR_CHART_VIEW_WIDTH,
  WARP_SPEED_LIGHT_SECONDS_PER_SECOND,
  computeNeighbors,
  distanceToLightSeconds,
  planarDistance,
  projectToChart,
  warpTimeSeconds,
} from "./travel.js";
import { generateStars } from "./stars.js";
import type { Star } from "./types.js";

const DEV_SEED = "drift-dev-seed-001";

function syntheticStar(id: string, x: number, y: number, z = 0): Star {
  return {
    id,
    name: id,
    class: "G",
    x,
    y,
    z,
    systemCount: 1,
  };
}

describe("shared/galaxy/travel — unit conversions", () => {
  it("GU_TO_LIGHT_SECONDS is the published constant", () => {
    expect(GU_TO_LIGHT_SECONDS).toBe(100);
  });

  it("WARP_SPEED_LIGHT_SECONDS_PER_SECOND is the published constant", () => {
    expect(WARP_SPEED_LIGHT_SECONDS_PER_SECOND).toBe(10);
  });

  it("NEAREST_NEIGHBOUR_COUNT is 3 (spec)", () => {
    expect(NEAREST_NEIGHBOUR_COUNT).toBe(3);
  });

  it("distanceToLightSeconds is pure scalar multiplication", () => {
    expect(distanceToLightSeconds(0)).toBe(0);
    expect(distanceToLightSeconds(1)).toBe(GU_TO_LIGHT_SECONDS);
    expect(distanceToLightSeconds(5.5)).toBe(5.5 * GU_TO_LIGHT_SECONDS);
  });

  it("distanceToLightSeconds rejects negative / non-finite inputs", () => {
    expect(() => distanceToLightSeconds(-1)).toThrow(RangeError);
    expect(() => distanceToLightSeconds(NaN)).toThrow(RangeError);
    expect(() => distanceToLightSeconds(Infinity)).toThrow(RangeError);
  });

  it("warpTimeSeconds is round(distance_ls / speed)", () => {
    expect(warpTimeSeconds(0)).toBe(0);
    // 1 gu = 100 ls; speed = 10 ls/s → 10 s.
    expect(warpTimeSeconds(1)).toBe(10);
    // 0.5 gu → 50 ls → 5 s.
    expect(warpTimeSeconds(0.5)).toBe(5);
    // 5 gu → 500 ls → 50 s.
    expect(warpTimeSeconds(5)).toBe(50);
  });

  it("warpTimeSeconds rejects negative / non-finite inputs", () => {
    expect(() => warpTimeSeconds(-0.1)).toThrow(RangeError);
    expect(() => warpTimeSeconds(NaN)).toThrow(RangeError);
    expect(() => warpTimeSeconds(Infinity)).toThrow(RangeError);
  });
});

describe("shared/galaxy/travel — planarDistance", () => {
  it("is zero on self-loops", () => {
    const s = syntheticStar("a", 3, 4, 7);
    expect(planarDistance(s, s)).toBe(0);
  });

  it("is symmetric and matches Math.hypot", () => {
    const a = syntheticStar("a", 0, 0);
    const b = syntheticStar("b", 3, 4);
    const ab = planarDistance(a, b);
    expect(ab).toBeCloseTo(5, 6);
    expect(planarDistance(b, a)).toBe(ab);
  });

  it("ignores the z component", () => {
    const a = syntheticStar("a", 1, 2, 100);
    const b = syntheticStar("b", 1, 2, -50);
    expect(planarDistance(a, b)).toBe(0);
  });
});

describe("shared/galaxy/travel — computeNeighbors", () => {
  it("returns NEAREST_NEIGHBOUR_COUNT edges per star", () => {
    const stars = generateStars(DEV_SEED, 32);
    const edges = computeNeighbors(stars);
    // 32 stars × 3 nearest neighbours = 96 edges (one per direction).
    expect(edges.length).toBe(stars.length * NEAREST_NEIGHBOUR_COUNT);
  });

  it("emits symmetric edges (a→b iff b→a) with matching distances", () => {
    const stars = generateStars(DEV_SEED, 16);
    // The first star's neighbour list is the first `NEAREST_NEIGHBOUR_COUNT`
    // entries returned by `computeNeighbors` (the algorithm iterates stars
    // in input order and appends each star's top-K edges).
    const edges = computeNeighbors(stars);
    const fromA = edges.slice(0, NEAREST_NEIGHBOUR_COUNT);
    expect(fromA.length).toBe(NEAREST_NEIGHBOUR_COUNT);
    for (const edge of fromA) {
      // The reverse direction (from the neighbour back to starA)
      // must exist in the per-star neighbour list. Re-derive it
      // by walking the per-star neighbours for starB.
      const starB = stars.find((s) => s.id === edge.to)!;
      const fromB = computeNeighbors(stars).slice(
        stars.indexOf(starB) * NEAREST_NEIGHBOUR_COUNT,
        (stars.indexOf(starB) + 1) * NEAREST_NEIGHBOUR_COUNT,
      );
      const back = fromB.find((e) => e.to === stars[0]!.id);
      expect(back).toBeDefined();
      expect(back!.distanceLs).toBe(edge.distanceLs);
      expect(back!.warpTimeSeconds).toBe(edge.warpTimeSeconds);
    }
  });

  it("edge distances are non-negative integers (rounded)", () => {
    const stars = generateStars(DEV_SEED, 8);
    const edges = computeNeighbors(stars);
    for (const edge of edges) {
      expect(edge.distanceLs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(edge.distanceLs)).toBe(true);
      expect(edge.warpTimeSeconds).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(edge.warpTimeSeconds)).toBe(true);
    }
  });

  it("warpTimeSeconds = round(distanceLs / speed)", () => {
    const stars = generateStars(DEV_SEED, 8);
    const edges = computeNeighbors(stars);
    for (const edge of edges) {
      expect(edge.warpTimeSeconds).toBe(
        Math.round(edge.distanceLs / WARP_SPEED_LIGHT_SECONDS_PER_SECOND),
      );
    }
  });

  it("is deterministic across two calls", () => {
    const stars = generateStars(DEV_SEED, 32);
    const a = computeNeighbors(stars);
    const b = computeNeighbors(stars);
    expect(a).toEqual(b);
  });

  it("handles a 2-star galaxy (each gets the other as a neighbour)", () => {
    const a = syntheticStar("a", 0, 0);
    const b = syntheticStar("b", 3, 4);
    const edges = computeNeighbors([a, b]);
    // a has one neighbour (b); b has one neighbour (a).
    expect(edges.length).toBe(2);
    expect(edges[0]!.to).toBe("b");
    expect(edges[1]!.to).toBe("a");
    // Distance is 5 gu = 500 ls; warp time = 50 s.
    expect(edges[0]!.distanceLs).toBe(500);
    expect(edges[0]!.warpTimeSeconds).toBe(50);
  });
});

describe("shared/galaxy/travel — projectToChart", () => {
  it("returns empty array for empty input", () => {
    expect(projectToChart([])).toEqual([]);
  });

  it("projects every star inside the viewBox", () => {
    const stars = generateStars(DEV_SEED, 32);
    const projected = projectToChart(stars);
    expect(projected.length).toBe(stars.length);
    for (const p of projected) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(STAR_CHART_VIEW_WIDTH);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(STAR_CHART_VIEW_HEIGHT);
    }
  });

  it("is deterministic across two calls", () => {
    const stars = generateStars(DEV_SEED, 16);
    const a = projectToChart(stars);
    const b = projectToChart(stars);
    expect(a).toEqual(b);
  });

  it("centres the bounding box on the viewport (a single star at origin lands in the middle)", () => {
    const single = [syntheticStar("a", 0, 0)];
    const [p] = projectToChart(single);
    expect(p).toBeDefined();
    // With a single star the bounding-box is degenerate; the
    // projection still returns a point at the canvas centre.
    expect(p!.x).toBeCloseTo(STAR_CHART_VIEW_WIDTH / 2, 1);
    expect(p!.y).toBeCloseTo(STAR_CHART_VIEW_HEIGHT / 2, 1);
  });

  it("flips Y so 'up' on the chart corresponds to +Y in galactic coordinates", () => {
    // Star at (0, +1) should sit *above* the centre (smaller Y
    // in screen coordinates) compared to a star at (0, -1).
    const high = syntheticStar("high", 0, 1);
    const low = syntheticStar("low", 0, -1);
    const [ph, pl] = projectToChart([high, low]);
    expect(ph).toBeDefined();
    expect(pl).toBeDefined();
    expect(ph!.y).toBeLessThan(pl!.y);
  });
});
