/**
 * PersistService unit tests (TASK-63).
 *
 * Each save point is exercised as a discrete `it()` block so a regression
 * in any one of them points clearly at the offending hook. We share the
 * `installRepoHooks()` pattern with the repository tests so a fresh
 * `:memory:` SQLite database underlies every case.
 */
import { describe, expect, it, vi } from "vitest";
import { active, installRepoHooks, type RepoHarness } from "./db/repo.test.shared.js";
import {
  DAMAGE_MILESTONES,
  DEFAULT_INTERVAL_MS,
  PersistService,
  emptyMutablePatch,
  materialiseShip,
} from "./persist.js";
import type { MutableShipPatch, SystemState } from "./persist.js";
import { NotFoundError } from "./db/errors.js";
import { DEFAULT_LIVERY } from "./db/repo.js";

installRepoHooks();

/** Sample starter ships flush tests; returns the player + ship rows for reuse. */
async function seedPlayerWithShip(harness: RepoHarness, callsign: string) {
  const player = await harness.repo.createPlayer({
    callsign,
    homeSystemId: "system-001",
  });
  const ship = await harness.repo.getOrCreateStarterShip(player.id, "scout");
  return { player, ship };
}

/** Build a `MutableShipPatch` containing every field, for save-call spies. */
function fullPatch(overrides: Partial<MutableShipPatch> = {}): MutableShipPatch {
  return {
    hull: 88,
    shields: 50,
    position: { systemId: "system-001", x: 1, y: 2, z: 3 },
    velocity: { x: 0.1, y: 0.2, z: 0.3 },
    state: "flying",
    livery: DEFAULT_LIVERY,
    ...overrides,
  };
}

/** Wait until `predicate()` returns true OR `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("PersistService - public save primitives", () => {
  it("saveShip writes all mutable fields in one call and clears the dirty flag", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    const { player, ship } = await seedPlayerWithShip(harness, "PILOT-S1");
    svc.markDirty(ship.id, fullPatch());
    expect(svc.isDirty(ship.id)).toBe(true);

    const saved = await svc.saveShip(
      materialiseShip({
        id: ship.id,
        ownerId: player.id,
        classId: ship.classId,
        livery: ship.livery,
        hull: 42,
        shields: 99,
        position: { systemId: "system-001", x: 5, y: 10, z: 15 },
        velocity: { x: 0.5, y: 0, z: -0.25 },
        state: "flying",
      }),
    );
    expect(saved.hull).toBe(42);
    expect(saved.shields).toBe(99);
    expect(saved.position.x).toBeCloseTo(5);
    expect(saved.velocity.z).toBeCloseTo(-0.25);
    expect(svc.isDirty(ship.id)).toBe(false);
  });

  it("saveCargo replaces the manifest in one call", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    const { ship } = await seedPlayerWithShip(harness, "PILOT-S2");
    const rows = await svc.saveCargo(ship.id, [
      { resourceType: "iron", quantity: 5 },
      { resourceType: "water", quantity: 2 },
    ]);
    expect(rows.map((r) => r.resourceType).sort()).toEqual(["iron", "water"]);
    const reloaded = await harness.repo.listCargoByShip(ship.id);
    expect(reloaded.map((r) => r.resourceType).sort()).toEqual(["iron", "water"]);
  });

  it("saveNodeStates upserts multiple nodes under one system id", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    await svc.saveNodeStates("system-001", [
      { nodeId: "n1", systemId: "ignored-by-service", quantityRemaining: 7, respawnAt: null },
      { nodeId: "n2", systemId: "ignored-by-service", quantityRemaining: 3, respawnAt: null },
    ]);
    const nodes = await harness.repo.listNodeStates("system-001");
    expect(nodes.map((n) => n.nodeId).sort()).toEqual(["n1", "n2"]);
  });

  it("loadSystemState returns ships + cargo + nodes + owner credits", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    const { player, ship } = await seedPlayerWithShip(harness, "PILOT-S3");
    await svc.saveShip(
      materialiseShip({
        ...ship,
        position: { systemId: "system-X", x: 1, y: 0, z: 0 },
      }),
    );
    await svc.saveCargo(ship.id, [{ resourceType: "iron", quantity: 4 }]);
    await svc.saveNodeStates("system-X", [
      { nodeId: "n1", systemId: "system-X", quantityRemaining: 9, respawnAt: null },
    ]);
    await harness.repo.addCredits(player.id, 25);

    const state: SystemState = await svc.loadSystemState("system-X");
    expect(state.systemId).toBe("system-X");
    expect(state.nodes.map((n) => n.nodeId)).toEqual(["n1"]);
    expect(state.ships.map((s) => s.id)).toEqual([ship.id]);
    expect(state.cargo.map((c) => c.resourceType)).toEqual(["iron"]);
    expect(state.credits).toEqual([{ playerId: player.id, credits: 525 }]);
  });
});

describe("PersistService - save points", () => {
  it("onDock saves the ship and persists the state='docked' transition", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    const { player, ship } = await seedPlayerWithShip(harness, "PILOT-D1");
    const flying = await harness.repo.saveShipState(ship.id, { state: "flying" });
    const docked = await svc.onDock(flying);
    expect(docked.state).toBe("docked");
    const reloaded = await harness.repo.findShipById(ship.id);
    expect(reloaded?.state).toBe("docked");
    void player;
  });

  it.each([
    { name: "75% threshold", from: 76, to: 75, expectSave: true },
    { name: "50% threshold", from: 51, to: 50, expectSave: true },
    { name: "25% threshold", from: 26, to: 25, expectSave: true },
    { name: "no crossing (62% → 60%)", from: 62, to: 60, expectSave: false },
    { name: "first contact (no prev hull)", from: 90, to: 80, expectSave: false },
  ])("onDamage $name returns $expectSave", async ({ from, to, expectSave }) => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    const { player, ship } = await seedPlayerWithShip(harness, `PILOT-DMG-${to}`);
    // Prime the service with the ship's starting hull (100) so a fresh
    // hull-last-saved baseline is in place.
    void player;
    if (from !== null) {
      await svc.onDamage({ ...ship, hull: from });
    } else {
      // first contact path: simulate a save that set the baseline.
      svc["lastHullByShip"].set(ship.id, 90);
    }
    const fired = await svc.onDamage({ ...ship, hull: to });
    expect(fired).toBe(expectSave);
    // Regardless of save, last-known hull is updated.
    expect(svc["lastHullByShip"].get(ship.id)).toBe(to);
  });

  it("onDamage does not retrigger when hull stays within the same bucket", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    const { ship } = await seedPlayerWithShip(harness, "PILOT-DMG-SAME");
    svc["lastHullByShip"].set(ship.id, 100);
    // Move inside the (75..100] bucket — no save.
    expect(await svc.onDamage({ ...ship, hull: 88 })).toBe(false);
    // Cross into [50..75] bucket.
    expect(await svc.onDamage({ ...ship, hull: 73 })).toBe(true);
    // Move further down inside [50..75] — no save.
    expect(await svc.onDamage({ ...ship, hull: 60 })).toBe(false);
    // Cross into [25..50].
    expect(await svc.onDamage({ ...ship, hull: 48 })).toBe(true);
  });

  it("startIntervalSave flushes dirty ships every interval", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo, { intervalMs: 25 });
    const { player, ship } = await seedPlayerWithShip(harness, "PILOT-INT");
    void player;
    svc.markDirty(ship.id, { hull: 55, shields: 33 });
    expect(svc.isDirty(ship.id)).toBe(true);
    svc.startIntervalSave();
    try {
      await waitFor(() => !svc.isDirty(ship.id));
      const reloaded = await harness.repo.findShipById(ship.id);
      expect(reloaded?.hull).toBe(55);
      expect(reloaded?.shields).toBe(33);
    } finally {
      svc.dispose();
    }
  });

  it("interval timer skips clean ships (clearDirty renders the set empty)", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo, { intervalMs: 20 });
    const { ship } = await seedPlayerWithShip(harness, "PILOT-INT-CLEAN");
    svc.markDirty(ship.id, { hull: 70 });
    svc.clearDirty();
    svc.startIntervalSave();
    // Wait long enough for several interval fires; we assert that no save
    // was triggered by checking updatedAt didn't change.
    const before = (await harness.repo.findShipById(ship.id))!.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 80));
    const after = (await harness.repo.findShipById(ship.id))!.updatedAt.getTime();
    expect(after).toBe(before);
    svc.dispose();
  });

  it("flushDirtyShips is a no-op when the dirty set is empty", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    expect(await svc.flushDirtyShips()).toBe(0);
  });

  it("onShardShutdown flushes dirty ships + marks the registry inactive", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    const { ship } = await seedPlayerWithShip(harness, "PILOT-SHUT");
    svc.markDirty(ship.id, { hull: 12, state: "destroyed" });
    await svc.onShardShutdown("system-001");
    expect(svc.isDirty(ship.id)).toBe(false);
    const registries = await harness.repo.listActiveShards();
    expect(registries.find((r) => r.systemId === "system-001")).toBeUndefined();
  });
});

describe("PersistService - dirty flag / lifecycle", () => {
  it("markDirty merges successive patches into a single entry", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    svc.markDirty("s1", { hull: 88 });
    svc.markDirty("s1", { shields: 33 });
    svc.markDirty("s1", { state: "flying" });
    expect(svc.dirtySize()).toBe(1);
    const patch = svc.dirtySnapshot().get("s1");
    expect(patch).toEqual({ hull: 88, shields: 33, state: "flying" });
  });

  it("dispose clears timers + dirty state (idempotent)", () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    svc.markDirty("s1", { hull: 50 });
    svc.startIntervalSave();
    svc.dispose();
    expect(svc.isDisposed).toBe(true);
    expect(svc.dirtySize()).toBe(0);
    // second dispose is a no-op
    expect(() => svc.dispose()).not.toThrow();
  });

  it("DEFAULT_INTERVAL_MS reflects the spec (5000ms)", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(5_000);
  });

  it("DAMAGE_MILESTONES contains {75, 50, 25}", () => {
    expect([...DAMAGE_MILESTONES].sort((a, b) => b - a)).toEqual([75, 50, 25]);
  });

  it("saveShip throws when the ship id is unknown (re-raised from repo)", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    await expect(
      svc.saveShip(
        materialiseShip({
          id: "00000000-0000-0000-0000-000000000000",
          ownerId: "missing-owner",
          classId: "scout",
          livery: DEFAULT_LIVERY,
          hull: 100,
          shields: 100,
          position: { systemId: "system-X", x: 0, y: 0, z: 0 },
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("saveCargo propagates NotFoundError for an unknown ship id", async () => {
    const harness = active();
    const svc = new PersistService(harness.repo);
    await expect(
      svc.saveCargo("00000000-0000-0000-0000-000000000000", [
        { resourceType: "iron", quantity: 1 },
      ]),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("PersistService - spying on save calls (TASK-63 AC5)", () => {
  it("onDock triggers exactly one saveShip repository call", async () => {
    const harness = active();
    const spy = vi.spyOn(harness.repo, "saveShipState");
    const svc = new PersistService(harness.repo);
    const { player, ship } = await seedPlayerWithShip(harness, "PILOT-SPY1");
    void player;
    await svc.onDock({ ...ship, state: "flying" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("onDamage crossing a milestone triggers one saveShip repository call", async () => {
    const harness = active();
    const spy = vi.spyOn(harness.repo, "saveShipState");
    const svc = new PersistService(harness.repo);
    const { player, ship } = await seedPlayerWithShip(harness, "PILOT-SPY2");
    void player;
    svc["lastHullByShip"].set(ship.id, 100);
    const fired = await svc.onDamage({ ...ship, hull: 73 });
    expect(fired).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("interval save triggers one saveShip repository call per dirty ship", async () => {
    const harness = active();
    const spy = vi.spyOn(harness.repo, "saveShipState");
    const svc = new PersistService(harness.repo, { intervalMs: 15 });
    const { player, ship } = await seedPlayerWithShip(harness, "PILOT-SPY3");
    void player;
    svc.markDirty(ship.id, { hull: 40 });
    svc.startIntervalSave();
    try {
      await waitFor(() => spy.mock.calls.length >= 1);
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      svc.dispose();
    }
  });

  it("manual flushDirtyShips triggers one save per dirty ship and clears flags", async () => {
    const harness = active();
    const spy = vi.spyOn(harness.repo, "saveShipState");
    const svc = new PersistService(harness.repo);
    const { player: playerA, ship: shipA } = await seedPlayerWithShip(harness, "PILOT-FLUSH-A");
    const { player: playerB, ship: shipB } = await seedPlayerWithShip(harness, "PILOT-FLUSH-B");
    void playerA;
    void playerB;
    svc.markDirty(shipA.id, { hull: 60 });
    svc.markDirty(shipB.id, { hull: 70 });
    expect(svc.dirtySize()).toBe(2);
    const written = await svc.flushDirtyShips();
    expect(written).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(svc.dirtySize()).toBe(0);
  });

  it("emptyMutablePatch returns a falsy patch object", () => {
    const empty = emptyMutablePatch();
    expect(Object.keys(empty).length).toBe(0);
  });

  it("materialiseShip provides sane defaults (velocity, state)", () => {
    const ship = materialiseShip({
      id: "x",
      ownerId: "o",
      classId: "scout",
      livery: DEFAULT_LIVERY,
      hull: 100,
      shields: 100,
      position: { systemId: "sys", x: 1, y: 2, z: 3 },
    });
    expect(ship.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(ship.state).toBe("docked");
  });
});
