/**
 * Tests for the shard-spawn hydrate (TASK-24).
 *
 * Validates the symmetric inverse of `flushShips`:
 *   - Inserts a player row + (optionally) wreck rows through the
 *     repository.
 *   - Calls `loadShipsForShard(systemId, repo)` and asserts the
 *     returned specs match the persisted state.
 *   - Confirms expired wrecks are GC'd *before* the hydrate runs.
 */
import { describe, expect, it } from "vitest";
import { active, installRepoHooks } from "../db/repo.test.shared.js";
import {
  loadShipsForShard,
  shipRowToEntitySpec,
  entityIdForSpec,
  specToEntityFields,
} from "./load.js";

installRepoHooks();

/** Convenience: create a player + starter ship in the 'flying' state
 * (the load path's default filter excludes docked ships). Returns
 * both rows so callers can save state changes on top.
 */
async function seedPlayerWithShip(callsign: string, systemId: string) {
  const { repo } = active();
  const player = await repo.createPlayer({ callsign, homeSystemId: systemId });
  const ship = await repo.getOrCreateStarterShip(player.id, "scout");
  // Starter ships are created with state='docked'; flip them to
  // 'flying' so the load path's "skip docked" filter doesn't drop
  // them. Tests that exercise the docked branch opt in via
  // `includeDocked: true`.
  await repo.saveShipState(ship.id, { state: "flying" });
  return { player, ship };
}

describe("loadShipsForShard (TASK-24)", () => {
  it("returns an empty array when the system has no ships", async () => {
    const { repo } = active();
    const result = await loadShipsForShard("system-EMPTY", repo);
    expect(result.specs).toEqual([]);
    expect(result.wrecksDeleted).toBe(0);
    expect(result.rowsScanned).toBe(0);
  });

  it("loads every player ship in the system with its saved state", async () => {
    const { repo } = active();
    const a = await seedPlayerWithShip("LOAD-A", "system-LOAD");
    // Move the first ship somewhere deterministic, then save it.
    await repo.saveShipState(a.ship.id, {
      position: { systemId: "system-LOAD", x: 100, y: 200, z: -50 },
      quat: [0.1, 0.2, 0.3, 0.9],
      hull: 70,
      shields: 40,
      state: "flying",
      regime: "atmosphere",
    });
    const b = await seedPlayerWithShip("LOAD-B", "system-LOAD");
    // And a ship in a DIFFERENT system that must NOT be returned.
    await seedPlayerWithShip("LOAD-OTHER", "system-OTHER");

    const result = await loadShipsForShard("system-LOAD", repo);
    expect(result.specs).toHaveLength(2);
    expect(result.rowsScanned).toBe(2);
    const ids = result.specs.map((s) => s.shipId).sort();
    expect(ids).toEqual([a.ship.id, b.ship.id].sort());

    const aSpec = result.specs.find((s) => s.shipId === a.ship.id)!;
    expect(aSpec.position.x).toBeCloseTo(100);
    expect(aSpec.position.y).toBeCloseTo(200);
    expect(aSpec.position.z).toBeCloseTo(-50);
    expect(aSpec.quat[0]).toBeCloseTo(0.1);
    expect(aSpec.quat[3]).toBeCloseTo(0.9);
    expect(aSpec.hull).toBe(70);
    expect(aSpec.shields).toBe(40);
    expect(aSpec.regime).toBe("atmosphere");
    expect(aSpec.state).toBe("flying");
  });

  it("skips docked ships by default (forward-compat: spec asks them to load at dock coords)", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "LOAD-DOCK", homeSystemId: "system-DOCK" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.saveShipState(ship.id, { state: "docked", onPad: "pad-0-0" });

    const def = await loadShipsForShard("system-DOCK", repo);
    expect(def.specs).toHaveLength(0);

    const inc = await loadShipsForShard("system-DOCK", repo, { includeDocked: true });
    expect(inc.specs).toHaveLength(1);
    expect(inc.specs[0]!.state).toBe("docked");
    expect(inc.specs[0]!.onPad).toBe("pad-0-0");
  });

  it("deletes expired wrecks in the same call (TASK-24 AC: no orphan rows)", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "LOAD-W", homeSystemId: "system-W" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");

    // Mark the ship destroyed with a wreck TTL in the past.
    const pastExpiry = Date.now() - 1_000;
    await repo.saveShipState(ship.id, {
      state: "destroyed",
      wreckExpiresAt: pastExpiry,
    });

    const result = await loadShipsForShard("system-W", repo);
    expect(result.wrecksDeleted).toBe(1);
    expect(result.specs).toHaveLength(0);

    // The row is gone (orphan cleanup).
    const after = await repo.findShipById(ship.id);
    expect(after).toBeNull();
  });

  it("preserves wrecks whose TTL is in the future", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "LOAD-WF", homeSystemId: "system-W" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const futureExpiry = Date.now() + 60_000;
    await repo.saveShipState(ship.id, {
      state: "destroyed",
      wreckExpiresAt: futureExpiry,
      position: { systemId: "system-W", x: 42, y: 7, z: 3 },
    });

    const result = await loadShipsForShard("system-W", repo);
    expect(result.wrecksDeleted).toBe(0);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.kind).toBe("wreck");
    expect(result.specs[0]!.wreckExpiresAt).toBe(futureExpiry);
    expect(result.specs[0]!.position.x).toBe(42);
  });

  it("ships in other systems are not returned (scoped to systemId)", async () => {
    const { repo } = active();
    await seedPlayerWithShip("LOAD-A", "system-A");
    await seedPlayerWithShip("LOAD-B", "system-B");
    await seedPlayerWithShip("LOAD-C", "system-B");

    const a = await loadShipsForShard("system-A", repo);
    const b = await loadShipsForShard("system-B", repo);
    expect(a.specs).toHaveLength(1);
    expect(b.specs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// shipRowToEntitySpec + specToEntityFields — patch round-trip helpers
// ---------------------------------------------------------------------------

describe("shipRowToEntitySpec", () => {
  it("classifies state='destroyed' rows as wreck entities", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "LOAD-X", homeSystemId: "system-X" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.saveShipState(ship.id, {
      state: "destroyed",
      wreckExpiresAt: Date.now() + 30_000,
    });
    const rows = await repo.listShipsBySystem("system-X");
    const spec = shipRowToEntitySpec(rows[0]!);
    expect(spec.kind).toBe("wreck");
    expect(spec.state).toBe("destroyed");
    expect(spec.wreckExpiresAt).not.toBeNull();
  });

  it("classifies state='flying' rows as player entities", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "LOAD-Y", homeSystemId: "system-Y" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const spec = shipRowToEntitySpec(ship);
    expect(spec.kind).toBe("player");
    expect(spec.state).toBe("docked");
    expect(spec.position).toEqual({ systemId: "system-Y", x: 0, y: 0, z: 0 });
  });

  it("defaults regime=null to 'space' (pre-TASK-24 rows backfill cleanly)", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "LOAD-Z", homeSystemId: "system-Z" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    // Manually clear the regime column to simulate a pre-TASK-24 row.
    // The mapper defaults it to null, the spec loader coerces null → 'space'.
    await repo.saveShipState(ship.id, { regime: null });
    const rows = await repo.listShipsBySystem("system-Z");
    const spec = shipRowToEntitySpec(rows[0]!);
    expect(spec.regime).toBe("space");
  });
});

describe("specToEntityFields + entityIdForSpec", () => {
  it("yields the canonical `entity:<shipId>` id for a player spec", () => {
    const spec = {
      shipId: "ship-1",
      playerId: "player-1",
      callsign: null,
      classId: "scout" as const,
      hull: 100,
      shields: 100,
      position: { systemId: "sys", x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      quat: [0, 0, 0, 1] as [number, number, number, number],
      regime: "space" as const,
      originPlanetId: null,
      onPad: null,
      wreckExpiresAt: null,
      // TASK-39: cargo hold carried by the spec.
      cargo: { stacks: {}, weightUsed: 0, capacity: 40 },
      kind: "player" as const,
      state: "flying" as const,
    };
    expect(entityIdForSpec(spec)).toBe("entity:ship-1");
    const fields = specToEntityFields(spec);
    expect(fields.id).toBe("entity:ship-1");
    expect(fields.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(fields.regime).toBe("space");
  });

  it("yields the canonical `wreck:entity:<shipId>` id for a wreck spec", () => {
    const spec = {
      shipId: "ship-2",
      playerId: null,
      callsign: null,
      classId: "scout" as const,
      hull: 0,
      shields: 0,
      position: { systemId: "sys", x: 5, y: 5, z: 5 },
      velocity: { x: 0, y: 0, z: 0 },
      quat: [0, 0, 0, 1] as [number, number, number, number],
      regime: "space" as const,
      originPlanetId: null,
      onPad: null,
      wreckExpiresAt: 1_000_000,
      // TASK-39: wrecks don't carry cargo (the destroyed ship has
      // no payload by spec) — empty placeholder matches the loader.
      cargo: { stacks: {}, weightUsed: 0, capacity: 0 },
      kind: "wreck" as const,
      state: "destroyed" as const,
    };
    expect(entityIdForSpec(spec)).toBe("wreck:entity:ship-2");
  });
});
