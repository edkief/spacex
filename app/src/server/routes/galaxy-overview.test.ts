/**
 * Tests for the `GET /api/galaxy/overview` route (TASK-7).
 *
 * Mirrors the structure of `galaxy-health.test.ts` — bearer-token
 * gating + payload shape + the cache behaviour (same
 * `(seed, starCount)` returns the same payload bytes).
 */
import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { installRepoHooks, active } from "../db/repo.test.shared.js";
import { generateStars } from "@shared/galaxy/stars.js";
import { registerGalaxyOverviewRoute, _resetOverviewCacheForTests } from "./galaxy-overview.js";
import { hashToken, mintToken } from "../auth/token.js";

installRepoHooks();

const SEED = "GALAXY-OVERVIEW-TEST-SEED";
const STAR_COUNT = 4;
const SECRET = "x".repeat(64);

interface Harness {
  app: FastifyInstance;
  close: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const { repo } = active();
  const app = Fastify({ logger: false });
  registerGalaxyOverviewRoute(app, {
    repo,
    sessionSecret: SECRET,
    galaxySeed: SEED,
    galaxyStarCount: STAR_COUNT,
  });
  await app.ready();
  return {
    app,
    close: async () => {
      await app.close();
    },
  };
}

async function mintSessionToken(playerId: string): Promise<string> {
  const { repo } = active();
  const { token } = mintToken(SECRET, { playerId, systemId: null });
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

describe("GET /api/galaxy/overview", () => {
  it("rejects missing bearer token with 401 unauthenticated", async () => {
    _resetOverviewCacheForTests();
    const h = await makeHarness();
    try {
      const res = await h.app.inject({ method: "GET", url: "/api/galaxy/overview" });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("unauthenticated");
    } finally {
      await h.close();
    }
  });

  it("rejects bad bearer token with 401 unauthenticated", async () => {
    _resetOverviewCacheForTests();
    const h = await makeHarness();
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/api/galaxy/overview",
        headers: { authorization: "Bearer not-a-real-token" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("returns 200 with the expected payload shape for a valid session", async () => {
    _resetOverviewCacheForTests();
    const h = await makeHarness();
    const playerId = await createPlayer("OVERVIEW-OK");
    const token = await mintSessionToken(playerId);
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/api/galaxy/overview",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      const overview = body.overview;
      expect(overview.galaxySeed).toBe(SEED);
      expect(typeof overview.viewBoxWidth).toBe("number");
      expect(typeof overview.viewBoxHeight).toBe("number");
      expect(overview.systems.length).toBe(STAR_COUNT);
      // Every system has the expected fields.
      for (const sys of overview.systems) {
        expect(typeof sys.systemId).toBe("string");
        expect(typeof sys.name).toBe("string");
        expect(typeof sys.starClass).toBe("string");
        expect(typeof sys.pos2D.x).toBe("number");
        expect(typeof sys.pos2D.y).toBe("number");
        expect(Array.isArray(sys.neighbors)).toBe(true);
        for (const edge of sys.neighbors) {
          expect(typeof edge.to).toBe("string");
          expect(typeof edge.distanceLs).toBe("number");
          expect(typeof edge.warpTimeSeconds).toBe("number");
        }
      }
      // currentSystemId is filled in from the player's home system.
      expect(overview.currentSystemId).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      await h.close();
    }
  });

  it("caches the payload across calls (same input → byte-equal JSON)", async () => {
    _resetOverviewCacheForTests();
    const h = await makeHarness();
    const playerId = await createPlayer("OVERVIEW-CACHE");
    const token = await mintSessionToken(playerId);
    try {
      const res1 = await h.app.inject({
        method: "GET",
        url: "/api/galaxy/overview",
        headers: { authorization: `Bearer ${token}` },
      });
      const res2 = await h.app.inject({
        method: "GET",
        url: "/api/galaxy/overview",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      // Strip the per-request `currentSystemId` (filled in from
      // the player's session, which is the same for both calls)
      // and compare the rest of the body byte-for-byte.
      expect(res1.body).toBe(res2.body);
    } finally {
      await h.close();
    }
  });

  it("deterministic across new instances with the same inputs", async () => {
    _resetOverviewCacheForTests();
    const h1 = await makeHarness();
    const playerId1 = await createPlayer("OVERVIEW-DET-A");
    const token1 = await mintSessionToken(playerId1);
    try {
      const res = await h1.app.inject({
        method: "GET",
        url: "/api/galaxy/overview",
        headers: { authorization: `Bearer ${token1}` },
      });
      expect(res.statusCode).toBe(200);
      const a = res.json();
      await h1.close();
      _resetOverviewCacheForTests();

      const h2 = await makeHarness();
      const playerId2 = await createPlayer("OVERVIEW-DET-B");
      const token2 = await mintSessionToken(playerId2);
      try {
        const res2 = await h2.app.inject({
          method: "GET",
          url: "/api/galaxy/overview",
          headers: { authorization: `Bearer ${token2}` },
        });
        expect(res2.statusCode).toBe(200);
        const b = res2.json();
        // The `currentSystemId` differs because the players have
        // different home system ids (each call picks the first
        // star). The chart payload itself (systems, neighbours)
        // is identical.
        expect(b.overview.systems.length).toBe(a.overview.systems.length);
        expect(b.overview.viewBoxWidth).toBe(a.overview.viewBoxWidth);
        expect(b.overview.viewBoxHeight).toBe(a.overview.viewBoxHeight);
        for (let i = 0; i < a.overview.systems.length; i++) {
          expect(b.overview.systems[i]!.systemId).toBe(a.overview.systems[i]!.systemId);
          expect(b.overview.systems[i]!.pos2D.x).toBe(a.overview.systems[i]!.pos2D.x);
          expect(b.overview.systems[i]!.pos2D.y).toBe(a.overview.systems[i]!.pos2D.y);
          expect(b.overview.systems[i]!.neighbors.length).toBe(
            a.overview.systems[i]!.neighbors.length,
          );
        }
      } finally {
        await h2.close();
      }
    } catch (err) {
      await h1.close().catch(() => {});
      throw err;
    }
  });
});
