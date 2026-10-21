/**
 * System body layer — TASK-76.
 *
 * The layer is React-free and driven straight from the frame loop,
 * so these tests exercise it as a plain object: seed + system id in,
 * three.js children out. No WebGL context is needed (geometry and
 * materials construct fine in node).
 */
import { Mesh, PointLight } from "three";
import { describe, expect, it, vi } from "vitest";

import { generateStars } from "@shared/galaxy/stars.js";

import { STAR_SYSTEM_OFFSET_M, computeSystemBodies } from "../../world/systemBodies.js";

import { SystemBodyLayer } from "./SystemBodyLayer.js";

const SEED = "DRIFT-TASK-76-LAYER";

function systemIds(seed: string, count = 2): string[] {
  return generateStars(seed, 4)
    .slice(0, count)
    .map((star) => star.id);
}

describe("SystemBodyLayer", () => {
  it("renders the star and its planets for a (seed, systemId) pair", () => {
    const [systemId] = systemIds(SEED);
    const layer = new SystemBodyLayer({ getSeed: () => SEED });
    expect(layer.sync(systemId ?? null)).toBe(true);

    const expected = computeSystemBodies(SEED, systemId ?? "");
    expect(layer.bodyCount).toBe(expected.bodyCount);
    expect(layer.systemId).toBe(systemId);

    // Star mesh + point light, then one group per planet.
    const starMesh = layer.root.children.find((child) => child.name.startsWith("star:"));
    expect(starMesh).toBeDefined();
    expect(starMesh?.position.z).toBeCloseTo(STAR_SYSTEM_OFFSET_M, 6);
    const lights = layer.root.children.filter((child) => child instanceof PointLight);
    expect(lights).toHaveLength(1);
    expect(lights[0]?.position.z).toBeCloseTo(STAR_SYSTEM_OFFSET_M, 6);

    const planetGroups = layer.root.children.filter((child) => child.name.startsWith("planet:"));
    expect(planetGroups).toHaveLength(expected.planets.length);
    const atmospheres = planetGroups.reduce(
      (n, group) => n + group.children.filter((child) => child.name === "atmosphere").length,
      0,
    );
    expect(atmospheres).toBe(expected.planets.filter((planet) => planet.hasAtmosphere).length);
    layer.dispose();
  });

  it("is a no-op when the system and seed are unchanged", () => {
    const [systemId] = systemIds(SEED);
    const layer = new SystemBodyLayer({ getSeed: () => SEED });
    layer.sync(systemId ?? null);
    const count = layer.bodyCount;
    const firstMesh = layer.root.children[0];

    expect(layer.sync(systemId ?? null)).toBe(false);
    expect(layer.bodyCount).toBe(count);
    // Same mesh instances — the cheap path does not rebuild.
    expect(layer.root.children[0]).toBe(firstMesh);
    layer.dispose();
  });

  it("rebuilds on a warp (different system) and on a seed change", () => {
    const [a, b] = systemIds(SEED);
    const layer = new SystemBodyLayer({ getSeed: () => SEED });
    layer.sync(a ?? null);
    expect(layer.sync(b ?? null)).toBe(true);
    expect(layer.systemId).toBe(b);

    let seed = SEED;
    const seeded = new SystemBodyLayer({ getSeed: () => seed });
    seeded.sync(a ?? null);
    seed = "DRIFT-TASK-76-LAYER-2";
    expect(seeded.sync(a ?? null)).toBe(true);
    seeded.dispose();
    layer.dispose();
  });

  it("renders nothing for an unknown system, a null system or a missing seed", () => {
    const layer = new SystemBodyLayer({ getSeed: () => SEED });
    expect(layer.sync("ffffffffffffffff")).toBe(true);
    expect(layer.bodyCount).toBe(0);

    expect(layer.sync(null)).toBe(true);
    expect(layer.bodyCount).toBe(0);

    const noSeed = new SystemBodyLayer({ getSeed: () => null });
    noSeed.sync("whatever");
    expect(noSeed.bodyCount).toBe(0);

    layer.dispose();
    noSeed.dispose();
  });

  it("disposes every body mesh and is idempotent", () => {
    const [systemId] = systemIds(SEED);
    const layer = new SystemBodyLayer({ getSeed: () => SEED });
    layer.sync(systemId ?? null);
    const starMesh = layer.root.children.find((child) => child instanceof Mesh);
    const disposeSpy = vi.spyOn(
      (starMesh as Mesh).geometry as unknown as { dispose: () => void },
      "dispose",
    );

    layer.dispose();
    expect(disposeSpy).toHaveBeenCalled();
    expect(layer.root.children).toHaveLength(0);
    expect(layer.bodyCount).toBe(0);
    layer.dispose();
    expect(layer.sync(systemId ?? null)).toBe(false);
  });
});
