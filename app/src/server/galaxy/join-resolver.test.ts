/**
 * Tests for the router-aware `JoinResolver` adapter (TASK-11).
 *
 * Covers the WS-side contract:
 *
 *   - Successful join returns a snapshot with `systemId`, `entities`,
 *     and a `snapshotTick` aligned to the active shard.
 *   - Cap-full returns an error tagged `{ code: 'system-full' }` so
 *     the WS handler can forward the wire code.
 *   - System-not-found returns `{ code: 'system-not-found' }` for
 *     unknown ids.
 *   - Auth: a callsign without a ship row returns
 *     `system-not-found` (defensive — every player should have a
 *     starter, but the resolver doesn't trust that invariant).
 */
import { describe, expect, it } from "vitest";

import { installRepoHooks, active } from "../db/repo.test.shared.js";
import { generateStars } from "@shared/galaxy/stars.js";

import { GalaxyRouter } from "./router.js";
import { buildRouterJoinResolver } from "./join-resolver.js";

installRepoHooks();

const SEED = "JOIN-RESOLVER-TEST-SEED";
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

function firstSystemIds(n: number): string[] {
  return generateStars(SEED, STAR_COUNT)
    .slice(0, n)
    .map((s) => s.id);
}

async function seedPlayer(callsign: string) {
  const { repo } = active();
  const player = await repo.createPlayer({
    callsign,
    homeSystemId: firstSystemIds(1)[0]!,
  });
  const ship = await repo.getOrCreateStarterShip(player.id, "scout");
  return { playerId: player.id, shipId: ship.id };
}

describe("buildRouterJoinResolver (TASK-11)", () => {
  it("returns a snapshot for a successful join", async () => {
    const { router, repo } = makeRouter();
    const sysId = firstSystemIds(1)[0]!;
    const { playerId, shipId } = await seedPlayer("JOIN-RES-1");
    const resolver = buildRouterJoinResolver({ repo, router });
    const result = await resolver(sysId, "JOIN-RES-1", "c1");
    expect(result.systemId).toBe(sysId);
    expect(Array.isArray(result.entities)).toBe(true);
    expect(typeof result.snapshotTick).toBe("number");
    expect(result.serverTickHz).toBe(20);
    // Connection is now bound to the shard.
    const shard = router.get(sysId)!;
    expect(shard.connections.has("c1")).toBe(true);
    // Player entity exists.
    const entity = shard.entities.get(`entity:${shipId}`);
    expect(entity).toBeDefined();
    expect(entity?.playerId).toBe(playerId);
  });

  it("throws system-full once the shard hits 16 players", async () => {
    const { router, repo } = makeRouter();
    const sysId = firstSystemIds(1)[0]!;
    const resolver = buildRouterJoinResolver({ repo, router });
    // Pre-fill 16 players via the router (which is the source of
    // truth for the cap).
    for (let i = 0; i < 16; i++) {
      const seeded = await seedPlayer(`CAP-${i.toString().padStart(2, "0")}`);
      const r = await router.joinSystem(sysId, {
        connId: `c${i}`,
        callsign: `CAP-${i.toString().padStart(2, "0")}`,
        playerId: seeded.playerId,
        ship: {
          id: seeded.shipId,
          classId: "scout",
          hull: 100,
          shields: 100,
          quat: [0, 0, 0, 1] as const,
        },
      });
      expect("code" in r).toBe(false);
    }
    // 17th join: must throw tagged `system-full`.
    const overflow = await seedPlayer("CAP-OVERFLOW");
    await expect(
      router.joinSystem(sysId, {
        connId: "c-overflow",
        callsign: "CAP-OVERFLOW",
        playerId: overflow.playerId,
        ship: {
          id: overflow.shipId,
          classId: "scout",
          hull: 100,
          shields: 100,
          quat: [0, 0, 0, 1] as const,
        },
      }),
    ).resolves.toMatchObject({ code: "system-full", systemId: sysId });
    // The resolver path also throws:
    const r = resolver(sysId, "CAP-OVERFLOW", "c-overflow");
    await expect(r).rejects.toMatchObject({ code: "system-full" });
  });

  it("throws system-not-found for unknown systems", async () => {
    const { router, repo } = makeRouter();
    const resolver = buildRouterJoinResolver({ repo, router });
    await expect(resolver("NOPE-SYSTEM", "PILOT-99", "c1")).rejects.toMatchObject({
      code: "system-not-found",
    });
  });

  it("throws system-not-found for missing callsign (defensive)", async () => {
    const { router, repo } = makeRouter();
    const sysId = firstSystemIds(1)[0]!;
    const resolver = buildRouterJoinResolver({ repo, router });
    // No matching player in the DB — defensive path: we surface the
    // same `system-not-found` so the wire code is uniform.
    await expect(resolver(sysId, "GHOST", "c1")).rejects.toMatchObject({
      code: "system-not-found",
    });
  });
});
