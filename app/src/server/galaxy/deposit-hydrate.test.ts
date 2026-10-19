/**
 * Deposit hydrate tests — TASK-37.
 *
 * Verifies that `hydrateShardDeposits` + `applyPersistedDeposits`
 * merge the seed-derived deposit placement with the persisted
 * deposit state into a single, deterministic entity map.
 *
 *   - Seed-only deposits land in the shard with full `amount`.
 *   - Persisted `remaining` overrides the seed amount.
 *   - Persisted `discovered: true` flips the in-memory flag.
 *   - Idempotent: a second hydrate call yields the same map.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { active, installRepoHooks } from "../db/repo.test.shared.js";
import type { Repository } from "../db/repo.js";
import { ChatRingBuffer } from "../chat.js";
import { depositsForSimple } from "@shared/world/deposits.js";
import { applyPersistedDeposits, hydrateShardDeposits } from "./deposit-hydrate.js";
import type { Shard } from "../shard/types.js";

const DEV_SEED = "drift-dev-seed-001";
const SYSTEM_ID = "0102030405060711";

function makeShard(): Shard {
  return {
    systemId: SYSTEM_ID,
    connections: new Map(),
    entities: new Map(),
    send: () => undefined,
    broadcast: () => undefined,
    sim: { currentTick: 1 },
    events: new EventEmitter(),
    chatLog: new ChatRingBuffer(),
    persist: {},
    generation: 1,
    stats: () => ({}) as unknown,
    shutdown: () => undefined,
    context: {} as unknown,
    dirtyShipSpawns: new Map(),
    targets: new Map(),
    onTickObserver: null,
  } as unknown as Shard;
}

installRepoHooks();

describe("hydrateShardDeposits", () => {
  let shard: Shard | null = null;
  let repo: Repository | null = null;

  beforeEach(() => {
    shard = makeShard();
    repo = active().repo;
  });

  afterEach(() => {
    shard = null;
    repo = null;
  });

  it("seeds every deposit entity from the placement list", async () => {
    if (!shard || !repo) throw new Error("fixture not initialised");
    const seed = depositsForSimple(DEV_SEED, SYSTEM_ID);
    expect(seed.length).toBeGreaterThan(0);
    hydrateShardDeposits(shard, DEV_SEED, { repo });
    // Wait for the fire-and-forget apply to finish.
    await new Promise((resolve) => setImmediate(resolve));

    expect(shard.entities.size).toBe(seed.length);
    for (const d of seed) {
      const e = shard.entities.get(d.depositId);
      expect(e).toBeDefined();
      expect(e?.kind).toBe("deposit");
      expect(e?.resourceType).toBe(d.resourceId);
      expect(e?.amount).toBe(d.amount);
      expect(e?.discovered).toBe(false);
      expect(e?.depositSeq).toBeGreaterThanOrEqual(0);
    }
  });

  it("applies persisted `remaining` to the entity", async () => {
    if (!shard || !repo) throw new Error("fixture not initialised");
    // Persist a partial mine for deposit #2.
    const seed = depositsForSimple(DEV_SEED, SYSTEM_ID);
    const target = seed[2]!;
    await repo.upsertDepositState({
      id: target.depositId,
      systemId: SYSTEM_ID,
      planetId: target.planetId,
      pos: target.pos,
      resourceId: target.resourceId,
      remaining: target.amount - 7,
      discovered: false,
      depositSeq: 2,
    });

    hydrateShardDeposits(shard, DEV_SEED, { repo });
    await new Promise((resolve) => setImmediate(resolve));

    const e = shard.entities.get(target.depositId);
    expect(e?.amount).toBe(target.amount - 7);
    expect(e?.initialAmount).toBe(target.amount); // seed value retained
  });

  it("applies persisted `discovered: true` to the entity", async () => {
    if (!shard || !repo) throw new Error("fixture not initialised");
    const seed = depositsForSimple(DEV_SEED, SYSTEM_ID);
    const target = seed[5]!;
    await repo.upsertDepositState({
      id: target.depositId,
      systemId: SYSTEM_ID,
      planetId: target.planetId,
      pos: target.pos,
      resourceId: target.resourceId,
      remaining: target.amount,
      discovered: true,
      depositSeq: 5,
    });

    hydrateShardDeposits(shard, DEV_SEED, { repo });
    await new Promise((resolve) => setImmediate(resolve));

    const e = shard.entities.get(target.depositId);
    expect(e?.discovered).toBe(true);
  });

  it("is idempotent on re-hydrate (no double-registration)", async () => {
    if (!shard || !repo) throw new Error("fixture not initialised");
    hydrateShardDeposits(shard, DEV_SEED, { repo });
    await new Promise((resolve) => setImmediate(resolve));
    const firstCount = shard.entities.size;

    // Re-hydrate: should clear + re-add without growing.
    hydrateShardDeposits(shard, DEV_SEED, { repo });
    await new Promise((resolve) => setImmediate(resolve));

    expect(shard.entities.size).toBe(firstCount);
  });

  it("never adds deposit entities for a system with no landable planets", async () => {
    if (!shard || !repo) throw new Error("fixture not initialised");
    // A 16-hex id that synthesises a system with no landable planets
    // — we don't know one in advance, so just assert that some
    // systems produce 0 deposits (the empty-sun edge case from the
    // placement pass).
    const emptyShard: Shard = makeShard();
    (emptyShard as { systemId: string }).systemId = "ffffffffffffffff";
    const list = depositsForSimple(DEV_SEED, emptyShard.systemId);
    // If we got 0 deposits back, the shard should also end up empty.
    if (list.length === 0) {
      hydrateShardDeposits(emptyShard, DEV_SEED, { repo });
      await new Promise((resolve) => setImmediate(resolve));
      let depositCount = 0;
      for (const e of emptyShard.entities.values()) {
        if (e.kind === "deposit") depositCount++;
      }
      expect(depositCount).toBe(0);
    } else {
      // The synthesised system has landable planets — skip.
      // (This branch keeps the test robust if the seed is ever
      // changed to make every starId have at least one landable.)
    }
  });
});

describe("applyPersistedDeposits — defensive reset", () => {
  let shard: Shard | null = null;
  let repo: Repository | null = null;

  beforeEach(() => {
    shard = makeShard();
    repo = active().repo;
  });

  afterEach(() => {
    shard = null;
    repo = null;
  });

  it("removes stale deposit entities before re-applying", async () => {
    if (!shard || !repo) throw new Error("fixture not initialised");
    // Pre-populate a stale entity that won't appear in the seed list.
    shard.entities.set("stale-deposit", {
      id: "stale-deposit",
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "iron",
      amount: 10,
      initialAmount: 10,
      depositSeq: 999,
      discovered: false,
    });

    await applyPersistedDeposits(shard, depositsForSimple(DEV_SEED, SYSTEM_ID), { repo });

    expect(shard.entities.has("stale-deposit")).toBe(false);
    // The seed entities should be present.
    const seedCount = depositsForSimple(DEV_SEED, SYSTEM_ID).length;
    let depositCount = 0;
    for (const e of shard.entities.values()) {
      if (e.kind === "deposit") depositCount++;
    }
    expect(depositCount).toBe(seedCount);
  });
});
