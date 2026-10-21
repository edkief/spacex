/**
 * Settings endpoint + persistence tests (TASK-55).
 *
 * Covers the acceptance criteria directly:
 *   - GET returns the shipped defaults for a fresh player
 *   - PUT persists; a *restart* (new app + repo over the same DB)
 *     loads the last settings as Low  ← the spec's round-trip test
 *   - an unknown quality preset → 400 invalid-settings
 *   - an out-of-range sensitivity is clamped (2.9 → 2.0, 0.1 → 0.5)
 *   - missing / bad bearer token → 401
 *   - `GET /api/session` carries the settings so a reconnect restores
 *     them without a second round trip
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { createSqliteTestDb } from "../db/client.js";
import { createSqliteRepository } from "../db/repo.sqlite.js";
import { registerCallsignRoutes } from "./callsigns.js";
import { registerSettingsRoutes } from "./settings.js";
import type { Repository } from "../db/repo.js";
import { DEFAULT_SETTINGS } from "@shared/settings.js";

const SESSION_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef";
const GALAXY_SEED = "DRIFT-TEST-001";

interface Harness {
  app: FastifyInstance;
  repo: Repository;
  close: () => void;
}

/** Build an app + repo over a fresh SQLite database. */
function newHarness(): Harness {
  const { db, close } = createSqliteTestDb();
  const repo = createSqliteRepository(db);
  const app = Fastify({ logger: false });
  registerCallsignRoutes(app, {
    repo,
    sessionSecret: SESSION_SECRET,
    claimDefaults: { galaxySeed: GALAXY_SEED, galaxyStarCount: 32 },
  });
  registerSettingsRoutes(app, { repo, sessionSecret: SESSION_SECRET });
  return { app, repo, close };
}

/** Claim a callsign and return its bearer token. */
async function claimToken(app: FastifyInstance, callsign: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/callsigns", payload: { callsign } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

describe("GET/PUT /api/players/settings", () => {
  let h: Harness;

  beforeEach(() => {
    h = newHarness();
  });

  afterEach(async () => {
    await h.app.close();
    h.close();
  });

  it("returns the shipped defaults for a fresh player", async () => {
    const token = await claimToken(h.app, "FreshPilot");
    const res = await h.app.inject({
      method: "GET",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ settings: DEFAULT_SETTINGS });
  });

  it("round-trips a PUT through the repo and back out of the GET", async () => {
    const token = await claimToken(h.app, "RoundTrip");
    const put = await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
      payload: { quality: "low", sensitivity: 1.4, reducedMotion: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      settings: { quality: "low", sensitivity: 1.4, reducedMotion: true, deviceProfile: "auto" },
    });
    const get = await h.app.inject({
      method: "GET",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(get.json()).toEqual({
      settings: { quality: "low", sensitivity: 1.4, reducedMotion: true, deviceProfile: "auto" },
    });
  });

  it("merges a partial PUT onto the stored record", async () => {
    const token = await claimToken(h.app, "Partial");
    await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
      payload: { sensitivity: 2 },
    });
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
      payload: { quality: "medium" },
    });
    expect(res.json()).toEqual({
      settings: { quality: "medium", sensitivity: 2, reducedMotion: false, deviceProfile: "auto" },
    });
  });

  it("clamps an out-of-range sensitivity instead of rejecting it", async () => {
    const token = await claimToken(h.app, "Clampy");
    const high = await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
      payload: { sensitivity: 2.9 },
    });
    expect(high.statusCode).toBe(200);
    expect((high.json() as { settings: { sensitivity: number } }).settings.sensitivity).toBe(2);
    const low = await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
      payload: { sensitivity: 0.1 },
    });
    expect((low.json() as { settings: { sensitivity: number } }).settings.sensitivity).toBe(0.5);
  });

  it("rejects an unknown quality preset with 400", async () => {
    const token = await claimToken(h.app, "BadPreset");
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
      payload: { quality: "ultra" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("invalid-settings");
  });

  it("rejects a non-numeric sensitivity with 400", async () => {
    const token = await claimToken(h.app, "BadSens");
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
      payload: { sensitivity: "fast" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("401s without a bearer token and with a bad one", async () => {
    const missing = await h.app.inject({ method: "GET", url: "/api/players/settings" });
    expect(missing.statusCode).toBe(401);
    const bad = await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: "Bearer nope" },
      payload: { quality: "low" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("carries the settings on the session response (no second fetch)", async () => {
    const token = await claimToken(h.app, "SessionCarry");
    await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
      payload: { quality: "low" },
    });
    const res = await h.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { settings: { quality: string } }).settings.quality).toBe("low");
  });

  it("restores the last settings after a 'restart' (new app, same DB)", async () => {
    const token = await claimToken(h.app, "Persister");
    await h.app.inject({
      method: "PUT",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
      payload: { quality: "low", sensitivity: 0.8, reducedMotion: true },
    });
    await h.app.close();

    // Simulated restart: a brand-new app instance over the same DB.
    const app2 = Fastify({ logger: false });
    registerCallsignRoutes(app2, {
      repo: h.repo,
      sessionSecret: SESSION_SECRET,
      claimDefaults: { galaxySeed: GALAXY_SEED, galaxyStarCount: 32 },
    });
    registerSettingsRoutes(app2, { repo: h.repo, sessionSecret: SESSION_SECRET });
    const res = await app2.inject({
      method: "GET",
      url: "/api/players/settings",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.json()).toEqual({
      settings: { quality: "low", sensitivity: 0.8, reducedMotion: true, deviceProfile: "auto" },
    });
    await app2.close();

    // Re-open for afterEach's close().
    h.app = Fastify({ logger: false });
  });
});
