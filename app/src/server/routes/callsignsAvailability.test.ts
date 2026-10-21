/**
 * GET /api/callsigns/availability — TASK-56 step 1.
 *
 * The claims screen probes this endpoint on a 500 ms debounce while
 * the player types. Three verdicts must be reachable, and the
 * transport status must always be 200 so the client can branch on
 * the `reason` field instead of on the status code:
 *
 *   - `available`      — valid format + unclaimed
 *   - `taken`          — valid format + already claimed
 *   - `invalid-format` — rejected locally by the shared schema
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerCallsignRoutes } from "./callsigns.js";
import { createSqliteTestDb } from "../db/client.js";
import { createRepository } from "../db/repo.js";
import type { Repository } from "../db/repo.js";
import { SECRET_MIN_BYTES } from "../auth/token.js";

const SECRET = "s".repeat(SECRET_MIN_BYTES);

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
    claimDefaults: { galaxySeed: "DRIFT-AVAIL", galaxyStarCount: 32, nowMs: Date.now() },
  });
  await app.ready();
  return {
    app,
    repo,
    close: async () => {
      await app.close();
      closeDb();
    },
  };
}

describe("GET /api/callsigns/availability", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await buildHarness();
  });
  afterAll(async () => {
    await harness.close();
  });

  it("reports an unclaimed callsign as available", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/callsigns/availability?callsign=Fresh-Pilot",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      callsign: "Fresh-Pilot",
      normalized: "fresh-pilot",
      available: true,
      reason: "available",
    });
  });

  it("reports a claimed callsign as taken (mirrors the case-sensitive claim path)", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/callsigns",
      payload: { callsign: "Taken-Pilot" },
    });
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/callsigns/availability?callsign=Taken-Pilot",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { available: boolean; reason: string; normalized: string };
    expect(body.available).toBe(false);
    expect(body.reason).toBe("taken");
    expect(body.normalized).toBe("taken-pilot");
  });

  it("reports a malformed callsign as invalid-format without touching the DB", async () => {
    for (const callsign of ["ab", "way-too-long-callsign", "bad callsign", "!!!"]) {
      const res = await harness.app.inject({
        method: "GET",
        url: `/api/callsigns/availability?callsign=${encodeURIComponent(callsign)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ available: false, reason: "invalid-format" });
    }
  });

  it("reports a missing query param as invalid-format", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/callsigns/availability" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ callsign: "", available: false, reason: "invalid-format" });
  });
});
