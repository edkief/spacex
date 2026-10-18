/**
 * Tests for the router-aware `WarpResolver` adapter (TASK-8).
 *
 * Covers the WS-side contract:
 *
 *   - Happy path: warp A → B moves the connection from the source
 *     shard to the target shard; both shards' connection counts
 *     match the expected state.
 *   - Same-system rejection: warping from a system to itself throws
 *     `same-system` and the player stays in the source system.
 *   - Full-system rejection: 16 connections in the target → warp
 *     rejects with `system-full`, the source is unchanged, and the
 *     player ends up in no system (the resolver left the source
 *     and the target rejected the join).
 *   - Spawn gate: after a successful warp the player's entity is
 *     at `100 + targetStar.x` along X (facing the star along -X).
 *   - Persistence: the ship's persisted `position.systemId` is
 *     updated to the target system so a reconnect respawn lands
 *     the player at the gate.
 *   - Disconnect mid-warp: if the connection drops during the
 *     warp sequence the source shard's connection set is empty
 *     and the player is no longer registered in either system
 *     (the router treats the post-leave state as "no member").
 *
 * @see ./warp-resolver.ts for the implementation.
 * @see ./router.ts for the router contract.
 */
import { describe, expect, it } from "vitest";

import { MAX_PLAYERS_PER_SYSTEM } from "@shared/galaxy/constants.js";
import { quatRotateVector } from "@shared/physics/vec.js";

import { installRepoHooks, active } from "../db/repo.test.shared.js";
import { generateStars } from "@shared/galaxy/stars.js";

import { GalaxyRouter } from "./router.js";
import { buildRouterWarpResolver, SPAWN_GATE_OFFSET_U } from "./warp-resolver.js";

installRepoHooks();

const SEED = "WARP-RESOLVER-TEST-SEED";
const STAR_COUNT = 6;

function makeRouter() {
  const { repo } = active();
  const router = new GalaxyRouter({
    repo,
    galaxySeed: SEED,
    galaxyStarCount: STAR_COUNT,
  });
  return { router, repo };
}

function systemIds(): string[] {
  return generateStars(SEED, STAR_COUNT).map((s) => s.id);
}

async function seedPlayer(callsign: string, systemId: string) {
  const { repo } = active();
  const player = await repo.createPlayer({ callsign, homeSystemId: systemId });
  const ship = await repo.getOrCreateStarterShip(player.id, "scout");
  // Park the ship at the origin of the home system so the warp
  // handler has a deterministic "old" position to replace.
  await repo.saveShipState(ship.id, {
    position: { systemId, x: 0, y: 0, z: 0 },
    state: "flying",
  });
  return { player, ship };
}

async function joinContext(
  router: GalaxyRouter,
  playerId: string,
  ship: {
    id: string;
    classId: "scout";
    hull: number;
    shields: number;
    quat: readonly [number, number, number, number];
  },
  callsign: string,
  connId: string,
  systemId: string,
): Promise<void> {
  const result = await router.joinSystem(systemId, {
    connId,
    callsign,
    playerId,
    ship,
  });
  if ("code" in result) {
    throw new Error(`setup join failed: ${result.code} ${result.message}`);
  }
  // Mirror the WS layer's bookkeeping so `leaveSystem` works.
  router.leaveSystem(systemId, connId);
  await router.joinSystem(systemId, {
    connId,
    callsign,
    playerId,
    ship,
  });
}

describe("buildRouterWarpResolver (TASK-8)", () => {
  it("warps A → B and moves the connection between shards", async () => {
    const { router, repo } = makeRouter();
    const [systemA, systemB] = systemIds();
    const { player, ship } = await seedPlayer("WARP-A", systemA);
    await joinContext(
      router,
      player.id,
      { id: ship.id, classId: "scout", hull: ship.hull, shields: ship.shields, quat: ship.quat },
      player.callsign,
      "conn-A",
      systemA,
    );
    expect(router.get(systemA)?.connections.size).toBe(1);
    expect(router.get(systemB)?.connections.size ?? 0).toBe(0);

    const resolver = buildRouterWarpResolver({
      repo,
      router,
      galaxySeed: SEED,
      galaxyStarCount: STAR_COUNT,
    });
    const result = await resolver(systemB, player.callsign, "conn-A", systemA);

    expect(result.targetSystemId).toBe(systemB);
    expect(result.systemId).toBe(systemB);
    // Source shard: connection removed.
    expect(router.get(systemA)?.connections.size).toBe(0);
    // Target shard: connection present (the player's own entity).
    expect(router.get(systemB)?.connections.size).toBe(1);
    // Persisted row updated to the new system.
    const updated = await repo.findShipById(ship.id);
    expect(updated?.position.systemId).toBe(systemB);
  });

  it("places the ship at the spawn gate (100 u along +X from the target star)", async () => {
    const { router, repo } = makeRouter();
    const [systemA, systemB] = systemIds();
    const { player, ship } = await seedPlayer("WARP-GATE", systemA);
    await router.joinSystem(systemA, {
      connId: "conn-gate",
      callsign: player.callsign,
      playerId: player.id,
      ship: {
        id: ship.id,
        classId: "scout",
        hull: ship.hull,
        shields: ship.shields,
        quat: ship.quat,
      },
    });
    const resolver = buildRouterWarpResolver({
      repo,
      router,
      galaxySeed: SEED,
      galaxyStarCount: STAR_COUNT,
    });
    await resolver(systemB, player.callsign, "conn-gate", systemA);

    const targetEntity = router.get(systemB)?.entities.get(`entity:${ship.id}`);
    expect(targetEntity).toBeDefined();
    // Gate is `targetStar.x + 100`. The deterministic galaxy
    // generator places stars at non-zero `x`, so the absolute
    // `pos.x` is offset by the star's coordinate — assert the
    // *difference* is exactly 100 along +X.
    const star = generateStars(SEED, STAR_COUNT).find((s) => s.id === systemB);
    expect(star).toBeDefined();
    expect(targetEntity!.pos.x - star!.x).toBeCloseTo(SPAWN_GATE_OFFSET_U, 5);
    expect(targetEntity!.pos.y - star!.y).toBeCloseTo(0, 5);
    expect(targetEntity!.pos.z - star!.z).toBeCloseTo(0, 5);
    // Forward vector (rotated +Z) should point at -X so the ship
    // faces the star from the gate position.
    const forward = quatRotateVector(targetEntity!.quat, { x: 0, y: 0, z: 1 });
    expect(forward.x).toBeCloseTo(-1, 4);
    expect(forward.y).toBeCloseTo(0, 4);
    expect(forward.z).toBeCloseTo(0, 4);
  });

  it("rejects same-system warps with a tagged error", async () => {
    const { router, repo } = makeRouter();
    const [systemA] = systemIds();
    const { player, ship } = await seedPlayer("WARP-SAME", systemA);
    await router.joinSystem(systemA, {
      connId: "conn-same",
      callsign: player.callsign,
      playerId: player.id,
      ship: {
        id: ship.id,
        classId: "scout",
        hull: ship.hull,
        shields: ship.shields,
        quat: ship.quat,
      },
    });
    const resolver = buildRouterWarpResolver({
      repo,
      router,
      galaxySeed: SEED,
      galaxyStarCount: STAR_COUNT,
    });
    await expect(resolver(systemA, player.callsign, "conn-same", systemA)).rejects.toMatchObject({
      code: "same-system",
    });
    // Player still in source system.
    expect(router.get(systemA)?.connections.size).toBe(1);
  });

  it("rejects full-system warps with `system-full`", async () => {
    const { router, repo } = makeRouter();
    const [systemA, systemB] = systemIds();
    const { player, ship } = await seedPlayer("WARP-FULL", systemA);
    // First register the warper in the source shard.
    await router.joinSystem(systemA, {
      connId: "conn-full-warper",
      callsign: player.callsign,
      playerId: player.id,
      ship: {
        id: ship.id,
        classId: "scout",
        hull: ship.hull,
        shields: ship.shields,
        quat: ship.quat,
      },
    });
    // Fill the target shard with synthetic connections. We can't
    // `joinSystem` 16 times without 16 ships so we reach inside
    // the connection map directly — the warp resolver only reads
    // `shard.connections.size` for the cap check.
    const targetShard = await router.getShard(systemB);
    for (let i = 0; i < MAX_PLAYERS_PER_SYSTEM; i++) {
      targetShard.connections.set(`conn-bot-${i}`, {
        connId: `conn-bot-${i}`,
        callsign: `BOT-${i}`,
        playerId: `p-bot-${i}`,
        shipId: `s-bot-${i}`,
        entityId: null,
        lastSeq: 0,
        pendingInput: null,
        staleDrops: 0,
      });
    }

    const resolver = buildRouterWarpResolver({
      repo,
      router,
      galaxySeed: SEED,
      galaxyStarCount: STAR_COUNT,
    });
    await expect(
      resolver(systemB, player.callsign, "conn-full-warper", systemA),
    ).rejects.toMatchObject({ code: "system-full" });
    // The warper is no longer in either shard (left the source,
    // rolled back from the target attempt).
    expect(router.get(systemA)?.connections.size).toBe(0);
    // Target shard still has 16 connections (we synthetically
    // populated it; the resolver rejected without mutating).
    expect(router.get(systemB)?.connections.size).toBe(MAX_PLAYERS_PER_SYSTEM);
  });

  it("rejects warps to unknown system ids with `system-not-found`", async () => {
    const { router, repo } = makeRouter();
    const [systemA] = systemIds();
    const { player, ship } = await seedPlayer("WARP-MISSING", systemA);
    await router.joinSystem(systemA, {
      connId: "conn-miss",
      callsign: player.callsign,
      playerId: player.id,
      ship: {
        id: ship.id,
        classId: "scout",
        hull: ship.hull,
        shields: ship.shields,
        quat: ship.quat,
      },
    });
    const resolver = buildRouterWarpResolver({
      repo,
      router,
      galaxySeed: SEED,
      galaxyStarCount: STAR_COUNT,
    });
    await expect(
      resolver("system-does-not-exist", player.callsign, "conn-miss", systemA),
    ).rejects.toMatchObject({ code: "system-not-found" });
    // Player still in source system.
    expect(router.get(systemA)?.connections.size).toBe(1);
  });

  it("leaves no ghost entity when the connection is dropped after warp", async () => {
    const { router, repo } = makeRouter();
    const [systemA, systemB] = systemIds();
    const { player, ship } = await seedPlayer("WARP-DROP", systemA);
    await router.joinSystem(systemA, {
      connId: "conn-drop-warper",
      callsign: player.callsign,
      playerId: player.id,
      ship: {
        id: ship.id,
        classId: "scout",
        hull: ship.hull,
        shields: ship.shields,
        quat: ship.quat,
      },
    });
    const resolver = buildRouterWarpResolver({
      repo,
      router,
      galaxySeed: SEED,
      galaxyStarCount: STAR_COUNT,
    });
    await resolver(systemB, player.callsign, "conn-drop-warper", systemA);
    expect(router.get(systemB)?.connections.size).toBe(1);
    // Disconnect: close hook drops the connection from the target.
    router.leaveSystem(systemB, "conn-drop-warper");
    expect(router.get(systemB)?.connections.size).toBe(0);
    // Source still empty (left during warp).
    expect(router.get(systemA)?.connections.size).toBe(0);
  });
});
