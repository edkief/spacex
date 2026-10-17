/**
 * Log-leak guard test (TASK-66).
 *
 * Acceptance: "Run a full claim→session→logout cycle with a log sink;
 * assert SESSION_SECRET, raw tokens, and token hashes never appear in
 * captured logs."
 *
 * Implementation:
 *   - Boot a Fastify app with `logger: true` (the default) and a custom
 *     stream that captures every log line into a string array.
 *   - Run the full /api/callsigns (claim) → /api/session (resume) →
 *     /api/session/logout (revoke) cycle.
 *   - Scan the captured stdout/stdouterr log output for the test
 *     SESSION_SECRET value, the issued token, and its sha256 hash.
 *   - The harness wipes the captured log after the test so a previous
 *     failure does not contaminate the next run.
 *
 * NOTE: We run this test against a fresh secret (`SECRET_UNDER_TEST`)
 * whose VALUE appears nowhere else in the codebase and is long enough
 * to satisfy `SECRET_MIN_BYTES`. The fixture also exposes a bare-minimum
 * "secret-canary" string the test greps for so a regression that logs
 * any literal secret value trips the assertion.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyLoggerOptions } from "fastify";
import { Writable } from "node:stream";

import { registerCallsignRoutes } from "../routes/callsigns.js";
import { createSqliteTestDb } from "../db/client.js";
import { createRepository } from "../db/repo.js";
import type { Repository } from "../db/repo.js";
import { hashToken } from "./token.js";

/**
 * A unique, long-arbitrary secret string dedicated to this test so a
 * search hit in the captured log is unambiguous. We embed a fixed
 * canary substring so even a regex collision on the surrounding bytes
 * still trips the assertion.
 */
// `t66-leak-canary-DO-NOT-USE-IN-PROD-` is already 35 bytes — strictly
// longer than the 32-byte HMAC key minimum — so we tack on a leading
// X-run for redundancy.
const SECRET_UNDER_TEST = `t66-leak-canary-DO-NOT-USE-IN-PROD-${"X".repeat(8)}`;
const SECRET_CANARY = "t66-leak-canary-DO-NOT-USE-IN-PROD";

interface Harness {
  app: FastifyInstance;
  repo: Repository;
  captured: string[];
  close: () => Promise<void>;
}

/**
 * Build a Fastify logger that writes JSON log lines into our `captured`
 * array via a custom stream. The level is `info` so structural fields
 * (auth attempts, route hits, etc.) land in the captured output.
 */
function buildLogger(captured: string[]): FastifyLoggerOptions {
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      captured.push(String(chunk));
      cb();
    },
  });
  // We deliberately keep this loosely typed: FastifyLoggerOptions is
  // re-exported from pino and accepts a Writable stream when supplied via
  // `stream:` on the raw object. Casting through `unknown` is simpler
  // than threading pino types into the test surface.
  return {
    level: "info",
    stream,
  } as unknown as FastifyLoggerOptions;
}

async function buildHarness(): Promise<Harness> {
  const captured: string[] = [];
  const { db, close: closeDb } = createSqliteTestDb();
  const repo = createRepository({ driver: "sqlite", db });
  const app = Fastify({ logger: buildLogger(captured) });
  registerCallsignRoutes(app, {
    repo,
    sessionSecret: SECRET_UNDER_TEST,
    claimDefaults: {
      galaxySeed: "DRIFT-LOG-LEAK",
      galaxyStarCount: 32,
    },
  });
  await app.ready();
  return {
    app,
    repo,
    captured,
    close: async () => {
      await app.close();
      closeDb();
    },
  };
}

/** Find any line containing a forbidden string. Returns the first match. */
function findForbidden(captured: readonly string[], needles: readonly string[]): string | null {
  for (const line of captured) {
    for (const needle of needles) {
      if (line.includes(needle))
        return `forbidden substring "${needle}" found in log line: ${line.trim()}`;
    }
  }
  return null;
}

describe("log-leak guard (TASK-66 acceptance)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await buildHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("SESSION_SECRET, raw tokens, and token hashes never appear in captured logs across a full claim→session→logout cycle", async () => {
    // Claim → grab the raw token.
    const claim = await harness.app.inject({
      method: "POST",
      url: "/api/callsigns",
      payload: { callsign: "LogLeak-1" },
    });
    expect(claim.statusCode).toBe(200);
    const claimBody = claim.json() as { token: string };
    const token = claimBody.token;
    expect(token.length).toBeGreaterThan(10);
    const tokenHash = hashToken(token);

    // Resume session with the raw token.
    const session = await harness.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.statusCode).toBe(200);

    // Logout with the raw token (revocation path).
    const logout = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(204);

    // Re-issue a sanity log line so the test runs against non-empty log
    // output even if Fastify were to silence every other emit.
    harness.app.log.info("log-leak sanity log line");

    // Build the forbidden-substrings list. The SECRET_UNDER_TEST is
    // treated as one giant substring; the canary is a short substring
    // that uniquely identifies it. The token is supplied verbatim. The
    // token hash is supplied verbatim.
    const forbidden: string[] = [SECRET_UNDER_TEST, SECRET_CANARY, token, tokenHash];

    const hit = findForbidden(harness.captured, forbidden);
    if (hit) {
      // Print a few captured lines for diagnosis. Production code must
      // NEVER include these strings; we err loudly here.
      const sample = harness.captured.slice(0, 12).join("\n");
      throw new Error(`log leak detected: ${hit}\nsample:\n${sample}`);
    }
    // Also assert the harness captured at least one line so a silent
    // fastify logger (logger: false) wouldn't sneak past.
    expect(harness.captured.length).toBeGreaterThan(0);
  });

  it("a tampered token login attempt does not leak SECRET or token parts to logs", async () => {
    // Fresh, very recognisable token half so a leak is obvious in
    // the captured stream.
    const probe = "AAAA.BBBB";
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { authorization: `Bearer ${probe}` },
    });
    expect(res.statusCode).toBe(401);

    const forbidden = [SECRET_UNDER_TEST, SECRET_CANARY, probe, hashToken(probe)];
    const hit = findForbidden(harness.captured, forbidden);
    if (hit) throw new Error(`log leak detected: ${hit}`);
  });

  it("a missing Authorization header does not leak to logs", async () => {
    const before = harness.captured.length;
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/session",
    });
    expect(res.statusCode).toBe(401);
    // The captured-log delta must not contain any forbidden substring
    // *that wasn't already there*. We test the simpler property: the
    // delta contains no forbidden substring.
    const delta = harness.captured.slice(before);
    const forbidden = [SECRET_UNDER_TEST, SECRET_CANARY];
    const hit = findForbidden(delta, forbidden);
    if (hit) throw new Error(`log leak detected on no-auth path: ${hit}`);
  });

  it("the logout error path does not leak SECRET or token to logs", async () => {
    // Claim a token, logout once, then attempt to logout again. The
    // double-logout path is the most likely place a developer would
    // accidentally console-log the presenting token.
    const claim = await harness.app.inject({
      method: "POST",
      url: "/api/callsigns",
      payload: { callsign: `LL-D-${Math.random().toString(36).slice(2, 6)}` },
    });
    expect(claim.statusCode).toBe(200);
    const token = (claim.json() as { token: string }).token;
    const tokenHash = hashToken(token);
    const logout1 = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout1.statusCode).toBe(204);
    const logout2 = await harness.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout2.statusCode).toBe(401);

    const forbidden = [SECRET_UNDER_TEST, SECRET_CANARY, token, tokenHash];
    const hit = findForbidden(harness.captured, forbidden);
    if (hit) throw new Error(`log leak detected: ${hit}`);
  });
});
