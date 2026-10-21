/**
 * Draw-plan tests — TASK-58 (the instancing / merging / pool passes).
 *
 * Each test pins one tuning pass: the pre-tuning renderer had one
 * draw call per entity; the tuned plan has a handful of batches and
 * a bounded material count.
 */
import { describe, expect, it } from "vitest";

import { PERF_PROFILES } from "@shared/perf.js";

import {
  DEPOSIT_RESOURCE_TYPES,
  LIVERY_POOL_SIZE,
  NAIVE_BATCH_SIZE,
  planDraws,
  type SceneComposition,
} from "./drawPlan.js";

const profile = PERF_PROFILES.high;

/** A worst-case-ish scene: 13 chunks, 30 deposits, 12 drones, 16
 *  ships, 20 labels, live combat FX. */
function scene(over: Partial<SceneComposition> = {}): SceneComposition {
  return {
    chunks: { near: 1, mid: 4, far: 8 },
    chunkTriangles: { near: 8_192, mid: 2_048, far: 128 },
    deposits: { iron: 12, copper: 9, "rare-earths": 6, crystal: 3 },
    drones: 12,
    hazardCells: 8,
    ships: 16,
    distinctLiveries: 6,
    labels: 20,
    stars: profile.starCount,
    fx: { "laser-flash": 24, "missile-tracer": 20, debris: 9 },
    ...over,
  };
}

/** Plan the scene and return the plan's metrics. */
function plan(s: SceneComposition = scene(), tuned = true) {
  return planDraws(s, { tuned }, profile);
}

describe("planDraws — terrain", () => {
  it("merges the surface chunks into one draw call per LOD ring", () => {
    const { batches, metrics } = plan();
    const rings = batches.filter((b) => b.name.startsWith("terrain"));
    expect(rings.map((b) => b.name)).toEqual(["terrain:near", "terrain:mid", "terrain:far"]);
    expect(rings.every((b) => b.drawCalls === 1)).toBe(true);
    expect(metrics.surfaceTriangles).toBe(1 * 8_192 + 4 * 2_048 + 8 * 128);
  });

  it("emits no ring batch for an empty ring", () => {
    const { batches } = plan(scene({ chunks: { near: 1, mid: 0, far: 0 } }));
    expect(batches.filter((b) => b.name.startsWith("terrain"))).toHaveLength(1);
  });

  it("gives the untuned renderer one full-detail mesh per chunk", () => {
    const { batches, metrics } = plan(scene(), false);
    const terrain = batches.find((b) => b.name.startsWith("terrain"))!;
    expect(terrain.drawCalls).toBe(13);
    expect(metrics.surfaceTriangles).toBe(13 * 8_192);
  });
});

describe("planDraws — instancing", () => {
  it("instances the deposits per resource type (4 calls for 30 deposits)", () => {
    const { batches, metrics } = plan();
    const deposits = batches.filter((b) => b.name.startsWith("deposits:"));
    expect(deposits.map((b) => b.name)).toEqual([
      "deposits:iron",
      "deposits:copper",
      "deposits:rare-earths",
      "deposits:crystal",
    ]);
    expect(metrics.drawCalls).toBeLessThan(20);
    expect(deposits.reduce((a, b) => a + b.instances, 0)).toBe(30);
    // One instanced call per resource type, whatever the count.
    expect(deposits.every((b) => b.drawCalls === 1)).toBe(true);
  });

  it("collapses every drone into a single instanced batch", () => {
    const drones = plan().batches.find((b) => b.name === "drones")!;
    expect(drones.drawCalls).toBe(1);
    expect(drones.instances).toBe(12);
  });

  it("splits a batch when it exceeds the profile's instance batch size", () => {
    const many = plan(scene({ drones: profile.instanceBatchSize * 2 + 5 })).batches.find(
      (b) => b.name === "drones",
    )!;
    expect(many.drawCalls).toBe(3);
  });

  it("draws the whole starfield as one points cloud", () => {
    const stars = plan().batches.find((b) => b.name === "stars")!;
    expect(stars.drawCalls).toBe(1);
    expect(stars.instances).toBe(profile.starCount);
    expect(stars.triangles).toBe(0);
  });

  it("caps the star count at the profile's cloud size", () => {
    const stars = plan(scene({ stars: profile.starCount * 4 })).batches.find(
      (b) => b.name === "stars",
    )!;
    expect(stars.instances).toBe(profile.starCount);
  });
});

describe("planDraws — livery pool", () => {
  it("binds one material per occupied livery slot, never per ship", () => {
    const ships = plan().batches.find((b) => b.name === "ships")!;
    expect(ships.kind).toBe("pooled-material");
    expect(ships.instances).toBe(16);
    expect(ships.materials).toBe(6);
    expect(ships.drawCalls).toBeLessThanOrEqual(LIVERY_POOL_SIZE);
  });

  it("never exceeds the pool size, however many liveries exist", () => {
    const ships = plan(scene({ ships: 60, distinctLiveries: 60 })).batches.find(
      (b) => b.name === "ships",
    )!;
    expect(ships.materials).toBe(LIVERY_POOL_SIZE);
    expect(ships.drawCalls).toBeLessThanOrEqual(LIVERY_POOL_SIZE);
  });

  it("uses one material when every ship shares a livery", () => {
    const ships = plan(scene({ ships: 8, distinctLiveries: 1 })).batches.find(
      (b) => b.name === "ships",
    )!;
    expect(ships.materials).toBe(1);
  });
});

describe("planDraws — FX caps and labels", () => {
  it("caps each FX kind at the profile budget and expires the rest", () => {
    const { metrics } = plan();
    expect(metrics.fx["laser-flash"]).toBe(profile.fxCaps.laserFlash);
    expect(metrics.fx["missile-tracer"]).toBe(profile.fxCaps.missile);
    expect(metrics.fx.debris).toBe(profile.fxCaps.debrisSet);
  });

  it("batches the FX into one instanced draw call per kind", () => {
    const fx = plan().batches.filter((b) => b.name.startsWith("fx:"));
    expect(fx.map((b) => b.drawCalls)).toEqual([1, 1, 1]);
  });

  it("caps the remote labels and costs them no draw call", () => {
    const labels = plan().batches.find((b) => b.name === "labels")!;
    expect(labels.kind).toBe("dom-overlay");
    expect(labels.drawCalls).toBe(0);
    expect(labels.instances).toBe(profile.maxLabels);
  });

  it("leaves the labels uncapped in the untuned baseline", () => {
    const labels = plan(scene({ labels: 40 }), false).batches.find((b) => b.name === "labels")!;
    expect(labels.instances).toBe(40);
  });

  it("multiplies debris shards into the triangle count", () => {
    const debris = plan().batches.find((b) => b.name === "fx:debris")!;
    expect(debris.triangles).toBe(profile.fxCaps.debrisSet * 8 * 12);
  });
});

describe("planDraws — budgets", () => {
  it("keeps the worst-case scene inside every High-preset budget", () => {
    const { metrics, withinBudget } = plan();
    expect(metrics.drawCalls).toBeLessThan(profile.budgets.drawCalls);
    expect(metrics.triangles).toBeLessThan(profile.budgets.triangles);
    expect(metrics.materials).toBeLessThan(profile.budgets.materials);
    expect(metrics.surfaceTriangles).toBeLessThan(profile.budgets.surfaceTriangles);
    expect(metrics.labels).toBeLessThanOrEqual(profile.maxLabels);
    expect(withinBudget).toBe(true);
  });

  it("costs far more draw calls and materials untuned", () => {
    const tuned = plan(scene(), true).metrics;
    const baseline = plan(scene(), false).metrics;
    expect(baseline.drawCalls).toBeGreaterThan(tuned.drawCalls * 5);
    expect(baseline.materials).toBeGreaterThan(tuned.materials * 2);
    expect(baseline.triangles).toBeGreaterThan(tuned.triangles);
  });

  it("handles an empty scene without batches or NaNs", () => {
    const empty = scene({
      chunks: { near: 0, mid: 0, far: 0 },
      deposits: {},
      drones: 0,
      ships: 0,
      labels: 0,
      stars: 0,
      fx: { "laser-flash": 0, "missile-tracer": 0, debris: 0 },
    });
    const { batches, metrics } = plan(empty);
    expect(batches).toHaveLength(0);
    expect(metrics.drawCalls).toBe(0);
    expect(metrics.triangles).toBe(0);
  });

  it("covers all four resource types in the deposit catalog", () => {
    expect([...DEPOSIT_RESOURCE_TYPES]).toEqual(["iron", "copper", "rare-earths", "crystal"]);
    expect(NAIVE_BATCH_SIZE).toBeGreaterThan(0);
  });
});
