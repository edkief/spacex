/**
 * Tests for the galaxy overview builder (`buildGalaxyOverview`).
 *
 * Coverage:
 *   - the payload echoes the seed + the spec's viewBox dimensions
 *   - the systems array is one entry per star
 *   - each node's `pos2D` matches `projectToChart(stars)[i]`
 *   - each node's `neighbors` list is the same as `computeNeighbors`
 *     from the same input (forward consistency)
 *   - `currentSystemId` is filled in per-request (default null)
 *   - determinism: same inputs → byte-equal output
 */
import { describe, it, expect } from "vitest";

import { buildGalaxyOverview } from "./overview.js";
import { generateStars } from "./stars.js";
import {
  STAR_CHART_VIEW_HEIGHT,
  STAR_CHART_VIEW_WIDTH,
  computeNeighbors,
  projectToChart,
} from "./travel.js";

const DEV_SEED = "drift-dev-seed-001";
const STAR_COUNT = 16;

describe("shared/galaxy/overview — buildGalaxyOverview", () => {
  it("echoes the seed and viewBox dimensions", () => {
    const ov = buildGalaxyOverview(DEV_SEED, STAR_COUNT);
    expect(ov.galaxySeed).toBe(DEV_SEED);
    expect(ov.viewBoxWidth).toBe(STAR_CHART_VIEW_WIDTH);
    expect(ov.viewBoxHeight).toBe(STAR_CHART_VIEW_HEIGHT);
  });

  it("returns one system entry per star, in star order", () => {
    const stars = generateStars(DEV_SEED, STAR_COUNT);
    const ov = buildGalaxyOverview(DEV_SEED, STAR_COUNT);
    expect(ov.systems.length).toBe(STAR_COUNT);
    for (let i = 0; i < stars.length; i++) {
      expect(ov.systems[i]!.systemId).toBe(stars[i]!.id);
    }
  });

  it("fills in the star name, star class, and pos2D consistently", () => {
    const stars = generateStars(DEV_SEED, STAR_COUNT);
    const projected = projectToChart(stars);
    const ov = buildGalaxyOverview(DEV_SEED, STAR_COUNT);
    for (let i = 0; i < stars.length; i++) {
      const node = ov.systems[i]!;
      const star = stars[i]!;
      // systemName == star.name + " system" suffix.
      expect(node.name).toBe(`${star.name} system`);
      expect(node.starClass).toBe(star.class);
      expect(node.pos2D.x).toBeCloseTo(projected[i]!.x, 2);
      expect(node.pos2D.y).toBeCloseTo(projected[i]!.y, 2);
    }
  });

  it("forwards the per-system neighbour list with matching distances", () => {
    const stars = generateStars(DEV_SEED, STAR_COUNT);
    const ov = buildGalaxyOverview(DEV_SEED, STAR_COUNT);
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i]!;
      const others = stars.filter((s) => s.id !== star.id);
      const expected = computeNeighbors([star, ...others]);
      const actual = ov.systems[i]!.neighbors;
      // Sort both by `to` to compare content (the overview's
      // order should be ascending warp time; the helper's is
      // also ascending). Sort to be robust.
      const sortedActual = [...actual].sort((a, b) => a.to.localeCompare(b.to));
      const sortedExpected = [...expected].sort((a, b) => a.to.localeCompare(b.to));
      expect(sortedActual.length).toBe(sortedExpected.length);
      for (let j = 0; j < sortedActual.length; j++) {
        expect(sortedActual[j]!.to).toBe(sortedExpected[j]!.to);
        expect(sortedActual[j]!.distanceLs).toBe(sortedExpected[j]!.distanceLs);
        expect(sortedActual[j]!.warpTimeSeconds).toBe(sortedExpected[j]!.warpTimeSeconds);
      }
    }
  });

  it("sets currentSystemId from the optional argument", () => {
    const stars = generateStars(DEV_SEED, STAR_COUNT);
    const target = stars[3]!.id;
    const ov = buildGalaxyOverview(DEV_SEED, STAR_COUNT, target);
    expect(ov.currentSystemId).toBe(target);
  });

  it("defaults currentSystemId to null", () => {
    const ov = buildGalaxyOverview(DEV_SEED, STAR_COUNT);
    expect(ov.currentSystemId).toBeNull();
  });

  it("is deterministic across two calls with the same inputs", () => {
    const a = buildGalaxyOverview(DEV_SEED, STAR_COUNT, "current");
    const b = buildGalaxyOverview(DEV_SEED, STAR_COUNT, "current");
    expect(a).toEqual(b);
  });

  it("changes currentSystemId without changing the layout", () => {
    const a = buildGalaxyOverview(DEV_SEED, STAR_COUNT, "alpha");
    const b = buildGalaxyOverview(DEV_SEED, STAR_COUNT, "beta");
    expect(a.viewBoxWidth).toBe(b.viewBoxWidth);
    expect(a.viewBoxHeight).toBe(b.viewBoxHeight);
    expect(a.systems.length).toBe(b.systems.length);
    expect(a.galaxySeed).toBe(b.galaxySeed);
    for (let i = 0; i < a.systems.length; i++) {
      expect(a.systems[i]!.pos2D.x).toBe(b.systems[i]!.pos2D.x);
      expect(a.systems[i]!.pos2D.y).toBe(b.systems[i]!.pos2D.y);
    }
    expect(a.currentSystemId).toBe("alpha");
    expect(b.currentSystemId).toBe("beta");
  });

  it("produces a different layout for a different seed", () => {
    const a = buildGalaxyOverview("seed-a", STAR_COUNT);
    const b = buildGalaxyOverview("seed-b", STAR_COUNT);
    let differs = false;
    for (let i = 0; i < a.systems.length; i++) {
      if (a.systems[i]!.systemId !== b.systems[i]!.systemId) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });
});
