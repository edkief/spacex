/**
 * `GET /api/galaxy/health` route test (TASK-11).
 *
 * The route is bearer-token gated and proxies `router.stats()` to
 * JSON. Tests assert:
 *
 *   - 401 + `unauthenticated` for missing/bad tokens.
 *   - 200 + `{ shards, shardCount, totalPlayers }` for a valid
 *     session; shard occupancy matches what the router knows.
 *   - Stats empty when no shards exist.
 */
import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { installRepoHooks, active } from "../db/repo.test.shared.js";
import { generateStars } from "@shared/galaxy/stars.js";
import { GalaxyRouter } from "../galaxy/router.js";
import { registerGalaxyHealthRoute } from "./galaxy-health.js";
import { hashToken, mintToken } from "../auth/token.js";

installRepoHooks();

const SEED = "GALAXY-HEALTH-TEST-SEED";
const STAR_COUNT = 4;
const SECRET = "x".repeat(64);

interface Harness {
  app: FastifyInstance;
  router: GalaxyRouter;
  repo: ReturnType<typeof active>["repo"];
  close: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const { repo } = active();
  const router = new GalaxyRouter({
    repo,
    galaxySeed: SEED,
    galaxyStarCount: STAR_COUNT,
  });
  const app = Fastify({ logger: false });
  registerGalaxyHealthRoute(app, {
    repo,
    sessionSecret: SECRET,
    router,
  });
  await app.ready();
  return {
    app,
    router,
    repo,
    close: async () => {
      await app.close();
      await router.shutdown();
    },
  };
}

async function mintSessionToken(playerId: string): Promise<string> {
  const { repo } = active();
  const { token } = mintToken(SECRET, { playerId, systemId: null });
  // Persist the session row so `loadSessionProfile` accepts the
  // bearer. `mintSessionToken` mirrors the live `claimCallsign` flow:
  // we never persist the raw token, only sha256(token).
  await repo.createSession({
    tokenHash: hashToken(token),
    playerId,
    systemId: null,
    ttlMs: 60 * 60 * 1000,
  });
  return token;
}

async function createPlayer(callsign: string): Promise<string> {
  const { repo } = active();
  const sysId = generateStars(SEED, STAR_COUNT)[0]!.id;
  const player = await repo.createPlayer({ callsign, homeSystemId: sysId });
  await repo.getOrCreateStarterShip(player.id, "scout");
  return player.id;
}

describe("GET /api/galaxy/health", () => {
  it("rejects missing bearer token with 401 unauthenticated", async () => {
    const h = await makeHarness();
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/api/galaxy/health",
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.code).toBe("unauthenticated");
    } finally {
      await h.close();
    }
  });

  it("rejects bad bearer token with 401 unauthenticated", async () => {
    const h = await makeHarness();
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/api/galaxy/health",
        headers: { authorization: "Bearer not-a-real-token" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("returns 200 with empty stats when no shards are active", async () => {
    const h = await makeHarness();
    const playerId = await createPlayer("HEALTH-EMPTY");
    const token = await mintSessionToken(playerId);
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/api/galaxy/health",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.shardCount).toBe(0);
      expect(body.totalPlayers).toBe(0);
      expect(body.shards).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("reflects the router's shard occupancy once players join", async () => {
    const h = await makeHarness();
    const playerId = await createPlayer("HEALTH-LIVE");
    const token = await mintSessionToken(playerId);
    try {
      // Bring up one shard via the router.
      const sysId = generateStars(SEED, STAR_COUNT)[0]!.id;
      const player = await h.repo.findPlayerById(playerId);
      expect(player).not.toBeNull();
      const ship = await h.repo.getOrCreateStarterShip(playerId, "scout");
      const result = await h.router.joinSystem(sysId, {
        connId: "conn-1",
        callsign: player!.callsign,
        playerId,
        ship: {
          id: ship.id,
          classId: "scout",
          hull: ship.hull,
          shields: ship.shields,
          quat: [0, 0, 0, 1] as const,
        },
      });
      expect("code" in result).toBe(false);

      const res = await h.app.inject({
        method: "GET",
        url: "/api/galaxy/health",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.shardCount).toBe(1);
      expect(body.totalPlayers).toBe(1);
      expect(body.shards).toHaveLength(1);
      const shard = body.shards[0]!;
      expect(shard.systemId).toBe(sysId);
      expect(shard.players).toBe(1);
      expect(typeof shard.uptimeMs).toBe("number");
      expect(typeof shard.name).toBe("string");
    } finally {
      await h.close();
    }
  });
});
