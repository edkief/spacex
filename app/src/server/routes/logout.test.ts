/**
 * POST /api/session/logout integration tests (TASK-66).
 *
 * Acceptance criteria covered:
 *   - POST /api/session/logout revokes the presenting token (delete row)
 *   - A second use of the same token returns 401
 *   - Garbage / tampered tokens return 401 without throwing
 *   - A successful logout is followed by a clean session on /api/session
 *
 * Boots a Fastify harness around `registerCallsignRoutes` (which now
 * includes the logout handler) + an in-memory SQLite repo. Uses
 * `fastify.inject` so no TCP port is bound.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerCallsignRoutes } from "./callsigns.js";
import { createSqliteTestDb } from "../db/client.js";
import { createRepository } from "../db/repo.js";
import type { Repository } from "../db/repo.js";
import { SECRET_MIN_BYTES, hashToken } from "../auth/token.js";

const SECRET = "r".repeat(SECRET_MIN_BYTES);
const FAKE_NOW_MS = 1_700_000_050_000;
const DEFAULTS = {
  galaxySeed: "DRIFT-LOGOUT-TEST",
  galaxyStarCount: 32,
  nowMs: FAKE_NOW_MS,
};

interface Harness {
  app: FastifyInstance;
  repo: Repository;
  close: () => void;
}

async function buildHarness(): Promise<Harness> {
  const { db, close: closeDb } = createSqliteTestDb();
  const repo = createRepository({ driver: "sqlite", db });
  const app = Fastify({ logger: false });
  registerCallsignRoutes(app, {
    repo,
    sessionSecret: SECRET,
    claimDefaults: DEFAULTS,
  });
  await app.ready();
  return {
    app,
    repo,
    close: () => {
      void app.close();
      closeDb();
    },
  };
}

/**
 * Claim a brand-new player + starter ship + session, returning the
 * 7-tuple the REST endpoints surface.
 */
async function claim(
  app: FastifyInstance,
  callsign: string,
): Promise<{
  token: string;
  playerId: string;
  homeSystemId: string;
  shipId: string;
  callsign: string;
  tokenExpiresAt: number;
}> {
  const res = await app.inject({
    method: "POST",
    url: "/api/callsigns",
    payload: { callsign },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    token: string;
    playerId: string;
    homeSystemId: string;
    shipId: string;
    callsign: string;
    tokenExpiresAt: number;
  };
}

describe("POST /api/session/logout (TASK-66)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await buildHarness();
  });

  afterAll(async () => {
    harness.close();
  });

  it("logs out a valid bearer token with 204", async () => {
    const { token } = await claim(harness.app, `Lo-OK-${Math.random().toString(36).slice(2, 6)}`);
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it("a second logout with the same token returns 401", async () => {
    const { token } = await claim(harness.app, `Lo-2x-${Math.random().toString(36).slice(2, 6)}`);
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(204);
    const second = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(401);
    const body = second.json() as { code: string; message: string };
    expect(body.code).toBe("unauthenticated");
  });

  it("deletes the sessions row so GET /api/session returns 401", async () => {
    const { token } = await claim(harness.app, `Lo-Sess-${Math.random().toString(36).slice(2, 6)}`);
    const r1 = await harness.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r1.statusCode).toBe(200);

    const logout = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(204);

    const r2 = await harness.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r2.statusCode).toBe(401);
  });

  it("the underlying sessions row was deleted from the DB", async () => {
    const { token } = await claim(harness.app, `Lo-DB-${Math.random().toString(36).slice(2, 6)}`);
    const before = await harness.repo.getSession(hashToken(token));
    expect(before).not.toBeNull();
    const logout = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(204);
    const after = await harness.repo.getSession(hashToken(token));
    expect(after).toBeNull();
  });

  it("rejects a missing Authorization header with 401", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { code: string };
    expect(body.code).toBe("unauthenticated");
  });

  it("rejects an empty Authorization header with 401", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: "" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed Bearer (no scheme) with 401", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: "NoBearer x.y.z" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a tampered MAC with 401", async () => {
    const { token } = await claim(harness.app, `Lo-Tmp-${Math.random().toString(36).slice(2, 6)}`);
    // Deterministic flip of the signature's final base64url char. The
    // naive `${slice(0,-1)}A` pattern was a no-op when the signature
    // already ended in `A`, making this test flaky ~5% of the time.
    const lastChar = token[token.length - 1];
    const replacement = lastChar === "A" ? "B" : "A";
    const tampered = `${token.slice(0, -1)}${replacement}`;
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a syntactically valid token whose signature uses a different secret with 401", async () => {
    const { mintToken } = await import("../auth/token.js");
    // Mint a token with a foreign secret; no DB row matches the hash.
    const { token } = mintToken("z".repeat(SECRET_MIN_BYTES), {
      playerId: "fictitious",
      ttlMs: 60_000,
      nowMs: FAKE_NOW_MS,
    });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not affect other players' session rows", async () => {
    const { token: aToken } = await claim(
      harness.app,
      `Lo-A-${Math.random().toString(36).slice(2, 4)}`,
    );
    const { token: bToken } = await claim(
      harness.app,
      `Lo-B-${Math.random().toString(36).slice(2, 4)}`,
    );
    const logout = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${aToken}` },
    });
    expect(logout.statusCode).toBe(204);
    // B's session is unaffected.
    const bRes = await harness.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { authorization: `Bearer ${bToken}` },
    });
    expect(bRes.statusCode).toBe(200);
  });
});
