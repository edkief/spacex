/**
 * Cargo-domain tests for the SQLite repository (TASK-62 AC5).
 *
 * Exercises `saveCargo` against a fresh in-memory database each test.
 * Validates wipe-and-replace semantics, zero-quantity filtering, and
 * `NotFoundError` for missing ships.
 */
import { describe, expect, it } from "vitest";
import { active, installRepoHooks } from "./repo.test.shared.js";
import { sqliteSchema } from "./schema.sqlite.js";
import { NotFoundError } from "./errors.js";

installRepoHooks();

describe("cargo", () => {
  it("saveCargo replaces the manifest atomically", async () => {
    const { repo, db } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-7",
      homeSystemId: "system-001",
    });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const first = await repo.saveCargo(ship.id, [
      { resourceType: "iron", quantity: 10 },
      { resourceType: "water", quantity: 5 },
    ]);
    expect(first.map((c) => c.resourceType).sort()).toEqual(["iron", "water"]);

    const second = await repo.saveCargo(ship.id, [
      { resourceType: "iron", quantity: 20 },
      { resourceType: "copper", quantity: 2 },
    ]);
    const types = second.map((c) => c.resourceType).sort();
    expect(types).toEqual(["copper", "iron"]);
    // water must be gone after the replace
    const persisted = db.select().from(sqliteSchema.cargoItems).all();
    const persistedTypes = persisted.map((r) => r.resourceType).sort();
    expect(persistedTypes).toEqual(["copper", "iron"]);
  });

  it("saveCargo silently drops zero-quantity items rather than inserting useless rows", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-8",
      homeSystemId: "system-001",
    });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const out = await repo.saveCargo(ship.id, [
      { resourceType: "iron", quantity: 0 },
      { resourceType: "water", quantity: 7 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.resourceType).toBe("water");
  });

  it("saveCargo raises NotFoundError when the ship is unknown", async () => {
    const { repo } = active();
    await expect(
      repo.saveCargo("00000000-0000-0000-0000-000000000000", [
        { resourceType: "iron", quantity: 5 },
      ]),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
