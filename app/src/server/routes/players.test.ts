/**
 * REST tests for the player self-service endpoint (TASK-41).
 *
 * Covers:
 *   - GET /api/players/me with a valid bearer token returns the full
 *     {callsign, credits, homeSystemId, shipId} payload
 *   - Missing / malformed bearer token → 401 unauthenticated
 *   - Tampered / revoked / unknown tokens → 401 unauthenticated
 *   - Credits round-trip: after add/withdraw through the repo, the
 *     endpoint reflects the updated balance on the next call
 *   - No endpoint exposes another player's balance in v1
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createSqliteTestDb } from "../db/client.js";
import { createSqliteRepository } from "../db/repo.sqlite.js";
import { registerCallsignRoutes } from "./callsigns.js";
import { registerPlayersRoutes } from "./players.js";
import type { Repository } from "../db/repo.js";

const SESSION_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef";
const GALAXY_SEED = "DRIFT-TEST-001";
const STAR_COUNT = 32;

interface Harness {
  app: FastifyInstance;
  repo: Repository;
  close: () => void;
}

function newHarness(): Harness {
  const { db, close } = createSqliteTestDb();
  const repo = createSqliteRepository(db);
  const app = Fastify({ logger: false });
  registerCallsignRoutes(app, {
    repo,
    sessionSecret: SESSION_SECRET,
    claimDefaults: {
      galaxySeed: GALAXY_SEED,
      galaxyStarCount: STAR_COUNT,
    },
  });
  registerPlayersRoutes(app, {
    repo,
    sessionSecret: SESSION_SECRET,
  });
  return { app, repo, close };
}

async function claimToken(
  app: FastifyInstance,
  callsign: string,
): Promise<{ token: string; playerId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/callsigns",
    payload: { callsign },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { token: string; playerId: string };
  return body;
}

describe("GET /api/players/me", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = newHarness();
  });
  afterEach(async () => {
    await harness.app.close();
    harness.close();
  });

  it("returns the caller's callsign, credits, homeSystemId, and shipId", async () => {
    const { token } = await claimToken(harness.app, "BRAVO-ONE");
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/players/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      callsign: string;
      credits: number;
      homeSystemId: string | null;
      shipId: string;
    };
    expect(body.callsign).toBe("BRAVO-ONE");
    expect(body.credits).toBe(500);
    expect(typeof body.homeSystemId).toBe("string");
    expect(body.homeSystemId).not.toBe("");
    expect(typeof body.shipId).toBe("string");
    expect(body.shipId.length).toBeGreaterThan(0);
  });

  it("reflects credit mutations on the next call", async () => {
    const { token, playerId } = await claimToken(harness.app, "BRAVO-TWO");
    await harness.repo.addCredits(playerId, 250);
    await harness.repo.withdrawCredits(playerId, 100);
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/players/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { credits: number };
    expect(body.credits).toBe(650);
  });

  it("rejects a missing Authorization header with 401", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/players/me",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      code: "unauthenticated",
      message: "Missing bearer token",
    });
  });

  it("rejects a malformed bearer header with 401", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/players/me",
      headers: { authorization: "NotBearer abc" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const { token } = await claimToken(harness.app, "BRAVO-THREE");
    // Tamper with the signature by flipping the last char.
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/players/me",
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a bearer that has been revoked via logout", async () => {
    const { token } = await claimToken(harness.app, "BRAVO-FOUR");
    // Revoke via the existing logout endpoint.
    const logoutRes = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logoutRes.statusCode).toBe(204);

    const res = await harness.app.inject({
      method: "GET",
      url: "/api/players/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not expose another player's balance (v1 surface only has /me)", async () => {
    // Even with a valid token, the only endpoint that returns credits
    // is /api/players/me. There is no /api/players/:id route; we
    // confirm by issuing a request and asserting the route map only
    // knows the me-prefix.
    const { token } = await claimToken(harness.app, "BRAVO-FIVE");
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/players/whatever-id",
      headers: { authorization: `Bearer ${token}` },
    });
    // Fastify returns 404 for an unregistered route.
    expect(res.statusCode).toBe(404);
  });

  it("two players each only see their own credits", async () => {
    const a = await claimToken(harness.app, "BRAVO-A");
    const b = await claimToken(harness.app, "BRAVO-B");
    await harness.repo.addCredits(a.playerId, 200);
    const resA = await harness.app.inject({
      method: "GET",
      url: "/api/players/me",
      headers: { authorization: `Bearer ${a.token}` },
    });
    const resB = await harness.app.inject({
      method: "GET",
      url: "/api/players/me",
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect((resA.json() as { credits: number }).credits).toBe(700);
    expect((resB.json() as { credits: number }).credits).toBe(500);
  });
});
