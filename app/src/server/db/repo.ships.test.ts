/**
 * Ship-domain tests for the SQLite repository (TASK-62 AC5).
 *
 * Exercises `getOrCreateStarterShip`, `findShipById`, `saveShipState`,
 * and `listShipsByOwner` against a fresh in-memory database each test.
 */
import { describe, expect, it } from "vitest";
import { active, installRepoHooks } from "./repo.test.shared.js";
import { NotFoundError } from "./errors.js";

installRepoHooks();

describe("ships", () => {
  it("getOrCreateStarterShip materialises the canonical starter ship on first call", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-1",
      homeSystemId: "system-007",
    });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    expect(ship.ownerId).toBe(player.id);
    expect(ship.classId).toBe("scout");
    expect(ship.state).toBe("docked");
    expect(ship.hull).toBe(100);
    expect(ship.shields).toBe(100);
    expect(ship.livery).toEqual({
      primary: "#3aa9ff",
      secondary: "#0d3a66",
      accent: "#ffffff",
    });
    expect(ship.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(ship.position).toEqual({
      systemId: "system-007",
      x: 0,
      y: 0,
      z: 0,
    });
  });

  it("getOrCreateStarterShip returns the existing ship on subsequent calls (no duplicates)", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-2",
      homeSystemId: "system-001",
    });
    const a = await repo.getOrCreateStarterShip(player.id, "freighter");
    const b = await repo.getOrCreateStarterShip(player.id, "interceptor");
    expect(b.id).toBe(a.id);
    expect(b.classId).toBe("freighter"); // original class wins
  });

  it("getOrCreateStarterShip throws NotFoundError when player is missing", async () => {
    const { repo } = active();
    await expect(
      repo.getOrCreateStarterShip("00000000-0000-0000-0000-000000000000", "scout"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("saveShipState updates each supplied field and refreshes updatedAt", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-3",
      homeSystemId: "system-001",
    });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const before = ship.updatedAt.getTime();

    // small sleep so updated_at differs
    await new Promise((r) => setTimeout(r, 10));

    const updated = await repo.saveShipState(ship.id, {
      state: "flying",
      hull: 73,
      shields: 50,
      position: { systemId: "system-001", x: 1.5, y: 2.5, z: -0.5 },
      velocity: { x: 0.1, y: 0, z: -0.2 },
      livery: { primary: "#ff00ff", secondary: "#000000", accent: "#ffffff" },
    });
    expect(updated.state).toBe("flying");
    expect(updated.hull).toBe(73);
    expect(updated.shields).toBe(50);
    expect(updated.position.x).toBeCloseTo(1.5);
    expect(updated.velocity.z).toBeCloseTo(-0.2);
    expect(updated.livery.primary).toBe("#ff00ff");
    expect(updated.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it("saveShipState clamps hull/shields to the 0..100 range", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-4",
      homeSystemId: "system-001",
    });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const ok = await repo.saveShipState(ship.id, { hull: 999, shields: -50 });
    expect(ok.hull).toBe(100);
    expect(ok.shields).toBe(0);
  });

  it("saveShipState rejects malformed livery JSON via zod", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-5",
      homeSystemId: "system-001",
    });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    await expect(
      // @ts-expect-error — wrong field type intentionally
      repo.saveShipState(ship.id, { livery: { primary: "blue" } }),
    ).rejects.toThrow();
  });

  it("saveShipState raises NotFoundError when the ship is unknown", async () => {
    const { repo } = active();
    await expect(
      repo.saveShipState("00000000-0000-0000-0000-000000000000", { state: "flying" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listShipsByOwner returns every ship owned by the given player", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-6",
      homeSystemId: "system-001",
    });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const list = await repo.listShipsByOwner(player.id);
    expect(list.map((s) => s.id)).toEqual([ship.id]);
  });

  // ---------------------------------------------------------------------
  // TASK-24 — listLiveShipsBySystem + deleteExpiredWrecks
  // ---------------------------------------------------------------------

  it("listLiveShipsBySystem scopes by systemId and excludes destroyed wrecks with no TTL", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "PILOT-LIVE", homeSystemId: "system-LIVE" });
    const flying = await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.saveShipState(flying.id, {
      state: "flying",
      position: { systemId: "system-LIVE", x: 1, y: 2, z: 3 },
    });

    // A destroyed ship with no TTL row should not appear. We use a
    // second player so the starter-ship factory doesn't dedupe to
    // the first row.
    const wreckPlayer = await repo.createPlayer({
      callsign: "PILOT-WRECK",
      homeSystemId: "system-LIVE",
    });
    const wreckNoTtl = await repo.getOrCreateStarterShip(wreckPlayer.id, "interceptor");
    await repo.saveShipState(wreckNoTtl.id, {
      state: "destroyed",
      wreckExpiresAt: null,
      position: { systemId: "system-LIVE", x: 0, y: 0, z: 0 },
    });

    // The list helper excludes destroyed-with-null-TTL rows by spec:
    //   state != 'destroyed' OR (state == 'destroyed' AND wreck_expires_at > now)
    // Only the flying ship satisfies the first clause.
    const list = await repo.listLiveShipsBySystem("system-LIVE", Date.now());
    expect(list.map((s) => s.id)).toEqual([flying.id]);
  });

  it("listLiveShipsBySystem keeps wrecks whose TTL is in the future", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "PILOT-WF", homeSystemId: "system-WF" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const futureExpiry = Date.now() + 60_000;
    await repo.saveShipState(ship.id, {
      state: "destroyed",
      wreckExpiresAt: futureExpiry,
      position: { systemId: "system-WF", x: 5, y: 0, z: 0 },
    });

    const list = await repo.listLiveShipsBySystem("system-WF", Date.now());
    expect(list).toHaveLength(1);
    expect(list[0]!.wreckExpiresAt).toBe(futureExpiry);
  });

  it("deleteExpiredWrecks removes rows whose TTL is in the past and returns the count", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "PILOT-WX", homeSystemId: "system-WX" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.saveShipState(ship.id, {
      state: "destroyed",
      wreckExpiresAt: Date.now() - 5_000,
    });

    const deleted = await repo.deleteExpiredWrecks("system-WX", Date.now());
    expect(deleted).toBe(1);

    const after = await repo.findShipById(ship.id);
    expect(after).toBeNull();
  });

  it("deleteExpiredWrecks is scoped by systemId (does not touch wrecks of other systems)", async () => {
    const { repo } = active();
    const a = await repo.createPlayer({ callsign: "PILOT-DA", homeSystemId: "system-A" });
    const aShip = await repo.getOrCreateStarterShip(a.id, "scout");
    await repo.saveShipState(aShip.id, {
      state: "destroyed",
      wreckExpiresAt: Date.now() - 1_000,
    });

    const b = await repo.createPlayer({ callsign: "PILOT-DB", homeSystemId: "system-B" });
    const bShip = await repo.getOrCreateStarterShip(b.id, "scout");
    await repo.saveShipState(bShip.id, {
      state: "destroyed",
      wreckExpiresAt: Date.now() - 1_000,
    });

    const deleted = await repo.deleteExpiredWrecks("system-A", Date.now());
    expect(deleted).toBe(1);

    // system-A row is gone; system-B row survives.
    expect(await repo.findShipById(aShip.id)).toBeNull();
    expect(await repo.findShipById(bShip.id)).not.toBeNull();
  });

  it("saveShipState round-trips every TASK-24 field (quat, regime, onPad, wreckExpiresAt)", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "PILOT-RT", homeSystemId: "system-RT" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");

    const updated = await repo.saveShipState(ship.id, {
      quat: [0.1, 0.2, 0.3, 0.9],
      regime: "atmosphere",
      onPad: "pad-1-2",
      wreckExpiresAt: 12345,
    });

    expect(updated.quat[0]).toBeCloseTo(0.1);
    expect(updated.quat[3]).toBeCloseTo(0.9);
    expect(updated.regime).toBe("atmosphere");
    expect(updated.onPad).toBe("pad-1-2");
    expect(updated.wreckExpiresAt).toBe(12345);

    // Reading back from the DB (not the in-memory merge) confirms
    // the row is genuinely persisted.
    const reread = await repo.findShipById(ship.id);
    expect(reread!.regime).toBe("atmosphere");
    expect(reread!.onPad).toBe("pad-1-2");
    expect(reread!.wreckExpiresAt).toBe(12345);
  });
});
