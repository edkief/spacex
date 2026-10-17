/**
 * World-domain tests for the SQLite repository (TASK-62 AC5).
 *
 * Covers resource-node persistence, session CRUD, and the system
 * registry upsert path against fresh in-memory databases per test.
 */
import { describe, expect, it } from "vitest";
import { active, installRepoHooks } from "./repo.test.shared.js";

installRepoHooks();

describe("resource node state", () => {
  it("upsertNodeState inserts and updates (round-trip)", async () => {
    const { repo } = active();
    const first = await repo.upsertNodeState({
      nodeId: "node-alpha",
      systemId: "system-001",
      quantityRemaining: 5,
      respawnAt: null,
    });
    expect(first.quantityRemaining).toBe(5);
    expect(first.systemId).toBe("system-001");

    const future = new Date(Date.now() + 60_000);
    const second = await repo.upsertNodeState({
      nodeId: "node-alpha",
      systemId: "system-001",
      quantityRemaining: 0,
      respawnAt: future,
    });
    expect(second.quantityRemaining).toBe(0);
    expect(second.respawnAt?.toISOString()).toBe(future.toISOString());
  });

  it("listNodeStates returns only nodes in the requested system", async () => {
    const { repo } = active();
    await repo.upsertNodeState({
      nodeId: "n1",
      systemId: "system-A",
      quantityRemaining: 1,
      respawnAt: null,
    });
    await repo.upsertNodeState({
      nodeId: "n2",
      systemId: "system-A",
      quantityRemaining: 2,
      respawnAt: null,
    });
    await repo.upsertNodeState({
      nodeId: "n3",
      systemId: "system-B",
      quantityRemaining: 3,
      respawnAt: null,
    });
    expect(await repo.listNodeStates("system-A")).toHaveLength(2);
    expect(await repo.listNodeStates("system-B")).toHaveLength(1);
    expect(await repo.listNodeStates("system-C")).toHaveLength(0);
  });
});

describe("sessions", () => {
  it("createSession/get/delete round-trip a token hash", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-12",
      homeSystemId: "system-001",
    });
    const session = await repo.createSession({
      tokenHash: "abc123",
      playerId: player.id,
      ttlMs: 60_000,
    });
    expect(session.playerId).toBe(player.id);
    expect(session.systemId).toBeNull();
    const found = await repo.getSession("abc123");
    expect(found?.tokenHash).toBe("abc123");
    expect(found?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await repo.deleteSession("abc123");
    expect(await repo.getSession("abc123")).toBeNull();
  });

  it("createSession honours the optional systemId and a custom TTL", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-13",
      homeSystemId: "system-001",
    });
    const session = await repo.createSession({
      tokenHash: "def456",
      playerId: player.id,
      systemId: "system-001",
      ttlMs: 5_000,
    });
    expect(session.systemId).toBe("system-001");
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeGreaterThanOrEqual(
      5_000 - 1_000,
    ); // allow clock slack
  });
});

describe("system registry", () => {
  it("upsertSystemRegistry marks a shard active and listActiveShards returns it", async () => {
    const { repo } = active();
    const a = await repo.upsertSystemRegistry({
      systemId: "sys-1",
      name: "Perexnius system",
      shardActive: true,
    });
    expect(a.shardActive).toBe(true);
    const b = await repo.upsertSystemRegistry({
      systemId: "sys-2",
      name: "Other system",
      shardActive: false,
    });
    expect(b.shardActive).toBe(false);
    const active2 = await repo.listActiveShards();
    expect(active2.map((r) => r.systemId)).toEqual(["sys-1"]);

    // Mark sys-2 active
    await repo.upsertSystemRegistry({
      systemId: "sys-2",
      name: "Other system",
      shardActive: true,
    });
    const nowActive = await repo.listActiveShards();
    expect(nowActive.map((r) => r.systemId).sort()).toEqual(["sys-1", "sys-2"]);
  });
});

describe("schema invariants", () => {
  it("every SQLite row maps to the driver-agnostic *Row shape", async () => {
    const { repo } = active();
    // Smoke test that the mapping layer coerces SQLite TEXT timestamps to Date.
    const player = await repo.createPlayer({
      callsign: "PILOT-14",
      homeSystemId: "system-001",
    });
    expect(player.createdAt).toBeInstanceOf(Date);
    const ship = await repo.getOrCreateStarterShip(player.id, "interceptor");
    expect(ship.updatedAt).toBeInstanceOf(Date);
    expect(ship.position).toHaveProperty("systemId");
    expect(ship.livery).toMatchObject({
      primary: expect.stringMatching(/^#[0-9a-fA-F]{6}$/u),
    });
  });
});
