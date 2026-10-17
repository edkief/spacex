/**
 * Server smoke tests.
 *
 * Boots a Fastify app via `buildApp()` and exercises the `/api/health`
 * endpoint with `inject()`. No TCP port is bound; the test stays fast and
 * isolated from any other process that might be using `PORT`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./server.js";
import { loadConfig } from "./config.js";
import type { HealthPayload } from "@shared/health.js";

describe("server /api/health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig();
    app = await buildApp(config, { quietLogger: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with ok=true and a galaxySeed", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as HealthPayload;
    expect(body.ok).toBe(true);
    expect(typeof body.galaxySeed).toBe("string");
    expect(body.galaxySeed.length).toBeGreaterThan(0);
  });
});
