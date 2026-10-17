/**
 * Repo-level tests for the `purchaseShip` transaction (TASK-20).
 *
 * Exercises the SQLite implementation directly against a fresh
 * in-memory DB so we get the cleanest assertion surface for the
 * transaction-wrap behaviour:
 *
 *   - happy path: scout → interceptor (atomic withdraw + ship swap)
 *   - happy path: scout → freighter
 *   - happy path: player already owns interceptor → still mid-flight
 *   - error: not docked → NotDockedError, no DB change
 *   - error: insufficient credits → InsufficientCreditsError, no DB
 *     change (no ship delete, no credit withdraw)
 *   - error: already-owned class → AlreadyOwnedShipError, no DB change
 *   - error: missing player → NotFoundError
 *
 * The Postgres twin gets parity via `pg.parity.test.ts`; we don't
 * repeat those cases here.
 */
import { describe, expect, it } from "vitest";
import { active, installRepoHooks } from "./repo.test.shared.js";
import { AlreadyOwnedShipError, InsufficientCreditsError, NotDockedError } from "./repo.js";
import { NotFoundError } from "./errors.js";

installRepoHooks();

describe("purchaseShip — happy paths", () => {
  it("scout → interceptor: withdraws 2500, persists a new ship, full stats", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PURCH-1",
      homeSystemId: "system-007",
    });
    await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.addCredits(player.id, 3000); // balance = 3500

    const before = await repo.listShipsByOwner(player.id);
    expect(before).toHaveLength(1);

    const newShip = await repo.purchaseShip({
      playerId: player.id,
      classId: "interceptor",
      price: 2500,
      hull: 80,
      shields: 40,
      livery: { primary: "#ff0000", secondary: "#000000", accent: "#ffffff" },
    });
    expect(newShip.classId).toBe("interceptor");
    expect(newShip.hull).toBe(80);
    expect(newShip.shields).toBe(40);
    expect(newShip.state).toBe("docked");
    expect(newShip.position.systemId).toBe("system-007");
    expect(newShip.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(newShip.livery).toEqual({
      primary: "#ff0000",
      secondary: "#000000",
      accent: "#ffffff",
    });

    // Post-conditions: balance debited, old ship row replaced.
    expect(await repo.getBalance(player.id)).toBe(1000);
    const after = await repo.listShipsByOwner(player.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(newShip.id);
    expect(after[0]!.classId).toBe("interceptor");
  });

  it("scout → freighter: withdraws 4000, biggest cargo + toughest hull applied", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PURCH-2",
      homeSystemId: "system-007",
    });
    await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.addCredits(player.id, 4000); // balance = 4500

    const newShip = await repo.purchaseShip({
      playerId: player.id,
      classId: "freighter",
      price: 4000,
      hull: 200,
      shields: 80,
      livery: { primary: "#3aa9ff", secondary: "#0d3a66", accent: "#ffffff" },
    });
    expect(newShip.classId).toBe("freighter");
    expect(newShip.hull).toBe(200);
    expect(newShip.shields).toBe(80);
    expect(await repo.getBalance(player.id)).toBe(500);
  });

  it("scrubs any cargo on the old ship (PRD §7 'cargo sell rule')", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PURCH-3",
      homeSystemId: "system-007",
    });
    const starter = await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.saveCargo(starter.id, [
      { resourceType: "iron", quantity: 10 },
      { resourceType: "water", quantity: 5 },
    ]);
    expect(await repo.listCargoByShip(starter.id)).toHaveLength(2);
    await repo.addCredits(player.id, 5000);

    const newShip = await repo.purchaseShip({
      playerId: player.id,
      classId: "interceptor",
      price: 2500,
      hull: 80,
      shields: 40,
      livery: { primary: "#ff00aa", secondary: "#112233", accent: "#ffffff" },
    });
    // Old ship row is gone → old cargo is gone (cascade).
    expect(await repo.findShipById(starter.id)).toBeNull();
    // New ship has a clean cargo manifest.
    expect(await repo.listCargoByShip(newShip.id)).toEqual([]);
  });
});

describe("purchaseShip — error paths", () => {
  it("rejects with NotDockedError when the player is mid-flight", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PURCH-DOCK-1",
      homeSystemId: "system-007",
    });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.saveShipState(ship.id, { state: "flying" });
    await repo.addCredits(player.id, 5000);

    await expect(
      repo.purchaseShip({
        playerId: player.id,
        classId: "interceptor",
        price: 2500,
        hull: 80,
        shields: 40,
        livery: { primary: "#ff00aa", secondary: "#112233", accent: "#ffffff" },
      }),
    ).rejects.toBeInstanceOf(NotDockedError);

    // DB untouched: ship still the scout, balance intact.
    const after = await repo.listShipsByOwner(player.id);
    expect(after[0]!.classId).toBe("scout");
    expect(await repo.getBalance(player.id)).toBe(5500);
  });

  it("rejects with InsufficientCreditsError when balance < price", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PURCH-CRED-1",
      homeSystemId: "system-007",
    });
    await repo.getOrCreateStarterShip(player.id, "scout");
    // Default balance = 500 < 2500.

    await expect(
      repo.purchaseShip({
        playerId: player.id,
        classId: "interceptor",
        price: 2500,
        hull: 80,
        shields: 40,
        livery: { primary: "#ff00aa", secondary: "#112233", accent: "#ffffff" },
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    // DB untouched: ship still the scout, balance intact.
    const after = await repo.listShipsByOwner(player.id);
    expect(after[0]!.classId).toBe("scout");
    expect(await repo.getBalance(player.id)).toBe(500);
  });

  it("rejects with AlreadyOwnedShipError when buying the same class", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PURCH-OWN-1",
      homeSystemId: "system-007",
    });
    await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.addCredits(player.id, 5000);

    // First buy: scout → interceptor.
    await repo.purchaseShip({
      playerId: player.id,
      classId: "interceptor",
      price: 2500,
      hull: 80,
      shields: 40,
      livery: { primary: "#ff00aa", secondary: "#112233", accent: "#ffffff" },
    });

    // Second buy: same class. The route maps this to 409.
    await expect(
      repo.purchaseShip({
        playerId: player.id,
        classId: "interceptor",
        price: 2500,
        hull: 80,
        shields: 40,
        livery: { primary: "#ff00aa", secondary: "#112233", accent: "#ffffff" },
      }),
    ).rejects.toBeInstanceOf(AlreadyOwnedShipError);

    // Ship is still the interceptor and balance is debited only once.
    const after = await repo.listShipsByOwner(player.id);
    expect(after[0]!.classId).toBe("interceptor");
    expect(await repo.getBalance(player.id)).toBe(3000); // 5500 - 2500
  });

  it("rejects with NotFoundError when the player has no ship row", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PURCH-NF-1",
      homeSystemId: "system-007",
    });
    // Note: no getOrCreateStarterShip call → no ship row.

    await expect(
      repo.purchaseShip({
        playerId: player.id,
        classId: "interceptor",
        price: 2500,
        hull: 80,
        shields: 40,
        livery: { primary: "#ff00aa", secondary: "#112233", accent: "#ffffff" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("purchaseShip — atomicity", () => {
  it("rejected buy leaves the credit balance untouched", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PURCH-RB-1",
      homeSystemId: "system-007",
    });
    await repo.getOrCreateStarterShip(player.id, "scout");
    await repo.addCredits(player.id, 5000);

    // Snapshot pre-state.
    const startBalance = await repo.getBalance(player.id);
    const startShip = (await repo.listShipsByOwner(player.id))[0]!;

    // Force a rejected buy: not docked.
    await repo.saveShipState(startShip.id, { state: "flying" });
    await expect(
      repo.purchaseShip({
        playerId: player.id,
        classId: "interceptor",
        price: 2500,
        hull: 80,
        shields: 40,
        livery: { primary: "#ff00aa", secondary: "#112233", accent: "#ffffff" },
      }),
    ).rejects.toBeInstanceOf(NotDockedError);

    // Balance untouched.
    expect(await repo.getBalance(player.id)).toBe(startBalance);
    // Ship untouched: same row, same classId, same hull.
    const afterShip = (await repo.listShipsByOwner(player.id))[0]!;
    expect(afterShip.id).toBe(startShip.id);
    expect(afterShip.classId).toBe("scout");
  });

  it("insufficient credits rolls back the credit withdraw \u2014 balance unchanged", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PURCH-RB-2",
      homeSystemId: "system-007",
    });
    await repo.getOrCreateStarterShip(player.id, "scout");
    // Default balance 500 < 2500.

    const startBalance = await repo.getBalance(player.id);
    const startShip = (await repo.listShipsByOwner(player.id))[0]!;

    await expect(
      repo.purchaseShip({
        playerId: player.id,
        classId: "interceptor",
        price: 2500,
        hull: 80,
        shields: 40,
        livery: { primary: "#ff00aa", secondary: "#112233", accent: "#ffffff" },
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(await repo.getBalance(player.id)).toBe(startBalance);
    const afterShip = (await repo.listShipsByOwner(player.id))[0]!;
    expect(afterShip.id).toBe(startShip.id);
    expect(afterShip.classId).toBe("scout");
  });
});
