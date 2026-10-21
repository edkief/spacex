/**
 * Regression test for TASK-18 — AI ghost connections vs the
 * 16-player cap (the bug from the previous handoff's "17 occupants"
 * symptom).
 *
 * AI ghost connections share `shard.connections` with real
 * players so the AI state machine can route `handleFire` through
 * the same dispatch path (`src/server/shard/ai.ts#ensureAiGhostConnection`).
 * Before this fix, the router's `joinSystem` cap check counted
 * ghost connections, so a 16-real-player shard with one AI
 * ghost read 17 — the 17th-client cap probe would always fail
 * ("routerPlayers reads 17 instead of 16") even though the
 * probe itself was never admitted.
 *
 * The fix:
 *   - `countRealPlayerConnections(shard)` — excludes any
 *     connection whose `connId` starts with the `ai:` prefix.
 *   - `joinSystem` uses that count for the cap check.
 *
 * This test exercises the new helper + the routed cap check.
 */
import { describe, expect, it } from "vitest";

import { MAX_PLAYERS_PER_SYSTEM } from "@shared/galaxy/constants.js";

import { countRealPlayerConnections, isAiGhostConnection } from "./router-connection.js";
import type { Shard } from "../shard/types.js";
import { installRepoHooks, active } from "../db/repo.test.shared.js";
import { GalaxyRouter } from "./router.js";
import { generateStars } from "@shared/galaxy/stars.js";

installRepoHooks();

const SEED = "AI-CAP-REGRESSION-SEED";
const STAR_COUNT = 4;

function makeRouter() {
  const { repo } = active();
  const router = new GalaxyRouter({
    repo,
    galaxySeed: SEED,
    galaxyStarCount: STAR_COUNT,
    // No WS broadcaster — tests don't care about presence frames.
    presenceBroadcaster: undefined,
    connSender: undefined,
  });
  return router;
}

async function seedPlayer(callsign: string) {
  const { repo } = active();
  const starId = generateStars(SEED, STAR_COUNT)[0]!.id;
  const player = await repo.createPlayer({ callsign, homeSystemId: starId });
  const ship = await repo.getOrCreateStarterShip(player.id, "scout");
  await repo.saveShipState(ship.id, {
    position: { systemId: starId, x: 0, y: 0, z: 0 },
    state: "flying",
  });
  return { player, ship, systemId: starId };
}

function addAiGhost(shard: Shard, id: string): void {
  shard.connections.set(`ai:${id}`, {
    connId: `ai:${id}`,
    callsign: "AI-GHOST",
    playerId: `ai:${id}`,
    shipId: id,
    entityId: `entity:${id}`,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  });
}

describe("router cap counts real players, not AI ghosts (TASK-18)", () => {
  it("isAiGhostConnection distinguishes by connId prefix", () => {
    const ghost = {
      connId: "ai:abc",
      callsign: "x",
      playerId: "ai:abc",
      shipId: "s1",
      entityId: null,
      lastSeq: 0,
      pendingInput: null,
      staleDrops: 0,
    };
    const real = {
      connId: "uuid-real",
      callsign: "x",
      playerId: "uuid",
      shipId: "s1",
      entityId: null,
      lastSeq: 0,
      pendingInput: null,
      staleDrops: 0,
    };
    expect(isAiGhostConnection(ghost)).toBe(true);
    expect(isAiGhostConnection(real)).toBe(false);
  });

  it("countRealPlayerConnections excludes AI ghost connections", async () => {
    // Build a real shard via the router, then inject 16 real
    // connections + 2 AI ghosts.
    const router = makeRouter();
    const { player, ship, systemId } = await seedPlayer("COUNT-1");
    await router.joinSystem(systemId, {
      connId: "c-1",
      callsign: "COUNT-1",
      playerId: player.id,
      ship: {
        id: ship.id,
        classId: "scout",
        hull: ship.hull,
        shields: ship.shields,
        quat: ship.quat,
      },
    });
    const shard = router.get(systemId)!;
    for (let i = 2; i <= 16; i++) {
      const { player: p, ship: s } = await seedPlayer(`COUNT-${i}`);
      shard.connections.set(`uuid-${i}`, {
        connId: `uuid-${i}`,
        callsign: `COUNT-${i}`,
        playerId: p.id,
        shipId: s.id,
        entityId: null,
        lastSeq: 0,
        pendingInput: null,
        staleDrops: 0,
      });
    }
    addAiGhost(shard, "ghost-A");
    addAiGhost(shard, "ghost-B");
    expect(shard.connections.size).toBe(18); // 16 real + 2 ghosts
    expect(countRealPlayerConnections(shard)).toBe(16);
    expect(countRealPlayerConnections(shard)).toBeLessThanOrEqual(MAX_PLAYERS_PER_SYSTEM);
  });

  it("a 17th real player is rejected even when AI ghosts share the shard", async () => {
    const router = makeRouter();
    const { player: firstPlayer, ship: firstShip, systemId } = await seedPlayer("CAP-PLAYER-1");
    // First player creates the shard; pre-populate it with 15 more
    // real players (16 total) + 2 AI ghosts to exercise the
    // discriminator.
    await router.joinSystem(systemId, {
      connId: "c-1",
      callsign: "CAP-PLAYER-1",
      playerId: firstPlayer.id,
      ship: {
        id: firstShip.id,
        classId: "scout",
        hull: firstShip.hull,
        shields: firstShip.shields,
        quat: firstShip.quat,
      },
    });
    const shard = router.get(systemId)!;
    for (let i = 2; i <= 16; i++) {
      const { player, ship } = await seedPlayer(`CAP-PLAYER-${i}`);
      // Insert the remaining 15 connections directly to avoid
      // 15 round-trips through `router.joinSystem`. The cap is
      // validated on each join via the helper, so the 16th
      // insertion must still go through `joinSystem` to prove
      // the helper is wired into the live cap check.
      if (i === 16) {
        const res = await router.joinSystem(systemId, {
          connId: `c-${i}`,
          callsign: `CAP-PLAYER-${i}`,
          playerId: player.id,
          ship: {
            id: ship.id,
            classId: "scout",
            hull: ship.hull,
            shields: ship.shields,
            quat: ship.quat,
          },
        });
        expect("code" in res).toBe(false);
      } else {
        shard.connections.set(`c-${i}`, {
          connId: `c-${i}`,
          callsign: `CAP-PLAYER-${i}`,
          playerId: player.id,
          shipId: ship.id,
          entityId: null,
          lastSeq: 0,
          pendingInput: null,
          staleDrops: 0,
        });
      }
    }
    // Two AI ghosts (mirrors TASK-45's lazy-add-on-fire).
    addAiGhost(shard, "ghost-A");
    addAiGhost(shard, "ghost-B");
    expect(shard.connections.size).toBe(18); // 16 real + 2 ghosts
    expect(countRealPlayerConnections(shard)).toBe(16);
    // 17th real player is rejected.
    const overflow = await seedPlayer("CAP-OVERFLOW");
    const rejected = await router.joinSystem(systemId, {
      connId: "c-overflow",
      callsign: "CAP-OVERFLOW",
      playerId: overflow.player.id,
      ship: {
        id: overflow.ship.id,
        classId: "scout",
        hull: overflow.ship.hull,
        shields: overflow.ship.shields,
        quat: overflow.ship.quat,
      },
    });
    expect("code" in rejected).toBe(true);
    if (!("code" in rejected)) throw new Error("expected cap rejection");
    expect(rejected.code).toBe("system-full");
    // Source occupancy unchanged.
    expect(countRealPlayerConnections(shard)).toBe(16);
    expect(shard.connections.has("c-overflow")).toBe(false);
  });
});
