/**
 * Hazard hydration tests — TASK-48.
 *
 * Covers the fire-and-forget `hydrateHazards` path that wires
 * the seed-derived hazard cells + drone entities onto a shard.
 *
 * The hydrate is invoked by `loadAndRegister`; we exercise it
 * directly here so the test stays focused on the hazard
 * registration contract (cells registered, drones spawned, no
 * double-registration on second hydrate).
 */
import { describe, expect, it } from "vitest";

import { hazardsFor, MAX_HAZARDS_PER_PLANET } from "@shared/world/hazards.js";

import { generateSystem } from "@shared/galaxy/system.js";
import { generateStars } from "@shared/galaxy/stars.js";
import { padsForSystem } from "@shared/world/pads.js";

import { hydrateHazards } from "./hazard-hydrate.js";
import { createShard } from "../shard/index.js";
import type { ShardSystemContext } from "../shard/types.js";

const DEV_SEED = "drift-dev-seed-001";

function firstNStarIds(seed: string, n: number): readonly string[] {
  const stars = generateStars(seed);
  return stars.slice(0, n).map((s) => s.id);
}

function makeShardContext(systemId: string): ShardSystemContext {
  const system = generateSystem(DEV_SEED, systemId);
  return {
    system,
    starId: systemId,
    planetById: () => undefined,
    heightAtFor: () => undefined,
    tileSizeM: 64,
  };
}

describe("hydrateHazards", () => {
  it("registers hazard cells and spawns drones for drone cells", () => {
    const id = firstNStarIds(DEV_SEED, 1)[0]!;
    const shard = createShard({
      systemId: id,
      context: makeShardContext(id),
      send: () => undefined,
      broadcast: () => undefined,
      autoStart: false,
    });
    const cells = hydrateHazards(shard, { seed: DEV_SEED });
    expect(cells.length).toBeGreaterThan(0);
    // The cells map mirrors the hazardsFor result.
    expect(shard.hazardCells.size).toBe(cells.length);
    // For every drone cell, the expected number of drone entities exists.
    let totalDrones = 0;
    for (const cell of cells) {
      if (cell.kind === "drones") {
        totalDrones += cell.droneCount;
      }
    }
    let actualDrones = 0;
    for (const entity of shard.entities.values()) {
      if (entity.kind === "drone") actualDrones++;
    }
    expect(actualDrones).toBe(totalDrones);
    shard.shutdown();
  });

  it("respects the per-planet cap", () => {
    const id = firstNStarIds(DEV_SEED, 1)[0]!;
    const shard = createShard({
      systemId: id,
      context: makeShardContext(id),
      send: () => undefined,
      broadcast: () => undefined,
      autoStart: false,
    });
    hydrateHazards(shard, { seed: DEV_SEED });
    // Group cells by planet and assert the cap holds.
    const grouped = new Map<string, number>();
    for (const cell of shard.hazardCells.values()) {
      grouped.set(cell.planetId, (grouped.get(cell.planetId) ?? 0) + 1);
    }
    for (const count of grouped.values()) {
      expect(count).toBeLessThanOrEqual(MAX_HAZARDS_PER_PLANET);
    }
    shard.shutdown();
  });

  it("is idempotent on the hazard list (no double spawn)", () => {
    const id = firstNStarIds(DEV_SEED, 1)[0]!;
    const shard = createShard({
      systemId: id,
      context: makeShardContext(id),
      send: () => undefined,
      broadcast: () => undefined,
      autoStart: false,
    });
    hydrateHazards(shard, { seed: DEV_SEED });
    const cellsBefore = shard.hazardCells.size;
    let dronesBefore = 0;
    for (const e of shard.entities.values()) {
      if (e.kind === "drone") dronesBefore++;
    }
    hydrateHazards(shard, { seed: DEV_SEED });
    expect(shard.hazardCells.size).toBe(cellsBefore);
    let dronesAfter = 0;
    for (const e of shard.entities.values()) {
      if (e.kind === "drone") dronesAfter++;
    }
    expect(dronesAfter).toBe(dronesBefore);
    shard.shutdown();
  });

  it("places no hazard within the 300 m + radius safe-zone of any pad", () => {
    const id = firstNStarIds(DEV_SEED, 1)[0]!;
    const system = generateSystem(DEV_SEED, id);
    const pads = padsForSystem({
      seed: DEV_SEED,
      starId: id,
      planets: system.planets,
    });
    const shard = createShard({
      systemId: id,
      context: makeShardContext(id),
      send: () => undefined,
      broadcast: () => undefined,
      autoStart: false,
    });
    hydrateHazards(shard, { seed: DEV_SEED });
    for (const cell of shard.hazardCells.values()) {
      for (const pad of pads) {
        if (pad.planetId !== cell.planetId) continue;
        const dx = cell.pos.x - pad.pos.x;
        const dz = cell.pos.z - pad.pos.z;
        const distSq = dx * dx + dz * dz;
        const min = 300 + cell.radius;
        expect(distSq).toBeGreaterThanOrEqual(min * min - 1e-3);
      }
    }
    shard.shutdown();
  });

  it("matches hazardsFor exactly when both paths see the same pads", () => {
    const id = firstNStarIds(DEV_SEED, 1)[0]!;
    const system = generateSystem(DEV_SEED, id);
    const pads = padsForSystem({
      seed: DEV_SEED,
      starId: id,
      planets: system.planets,
    });
    const byPlanet = new Map<string, Array<{ pos: { x: number; y: number; z: number } }>>();
    for (const pad of pads) {
      const arr = byPlanet.get(pad.planetId) ?? [];
      arr.push({ pos: pad.pos });
      byPlanet.set(pad.planetId, arr);
    }
    const shard = createShard({
      systemId: id,
      context: makeShardContext(id),
      send: () => undefined,
      broadcast: () => undefined,
      autoStart: false,
    });
    const cellsFromHydrate = hydrateHazards(shard, { seed: DEV_SEED });
    const cellsFromPure = hazardsFor({
      seed: DEV_SEED,
      systemId: id,
      padsByPlanet: byPlanet,
    });
    expect(cellsFromHydrate).toEqual(cellsFromPure);
    shard.shutdown();
  });
});
