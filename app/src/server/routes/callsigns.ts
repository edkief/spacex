/**
 * REST routes for callsign claims (TASK-10).
 *
 *   POST /api/callsigns
 *     body: { callsign }
 *     200:  { callsign, token, playerId, homeSystemId, shipId, tokenExpiresAt }
 *     409:  { code: "callsign-taken", message }
 *     422:  { code: "invalid-callsign", message }
 *
 *   GET /api/session
 *     header: Authorization: Bearer <token>
 *     200:  { playerId, callsign, credits, homeSystemId, shipId, tokenExpiresAt }
 *     401:  { code: "unauthenticated", message }
 *
 *   POST /api/session/logout                       (TASK-66)
 *     header: Authorization: Bearer <token>
 *     204:  (no body) on a successful revocation
 *     401:  { code: "unauthenticated", message }  — token missing / bad / already revoked
 *
 * Sessions are stored by `sha256(token)` so we never touch the raw
 * token past the response. Tests can inject an in-memory repo via the
 * shared harness builder.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { Repository } from "../db/repo.js";
import { CallsignTakenError } from "../db/errors.js";
import {
  claimCallsign,
  loadSessionProfile,
  revokeSession,
  type ClaimOptions,
} from "../auth/resolver.js";

/** Public deps shared by tests and the live server. */
export interface CallsignsDeps {
  repo: Repository;
  sessionSecret: string;
  claimDefaults: ClaimOptions;
}

/** Bearer-token extractor (case-insensitive, per RFC 7235). */
function readBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization ?? req.headers.Authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^Bearer\s+/iu.test(trimmed)) return null;
  return trimmed.slice("Bearer ".length).trim();
}

/** Structured error body used for every failure response. */
function errBody(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

/**
 * Register the callsign + session REST handlers on the given Fastify
 * instance.
 *
 * `buildApp()` is the only intended caller; tests wrap their own
 * Fastify + deps and call this directly so they can supply an
 * in-memory repo.
 */
export function registerCallsignRoutes(app: FastifyInstance, deps: CallsignsDeps): void {
  app.post("/api/callsigns", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { callsign?: unknown };
    const callsign = typeof body.callsign === "string" ? body.callsign : "";
    try {
      const result = await claimCallsign(
        deps.repo,
        deps.sessionSecret,
        callsign,
        deps.claimDefaults,
      );
      return reply.code(200).send({
        callsign: result.callsign,
        token: result.token,
        playerId: result.playerId,
        homeSystemId: result.homeSystemId,
        shipId: result.shipId,
        tokenExpiresAt: result.tokenExpiresAt,
      });
    } catch (err) {
      if (err instanceof CallsignTakenError) {
        return reply.code(409).send(errBody("callsign-taken", "Callsign already claimed"));
      }
      if (err instanceof Error && err.name === "InvalidCallsignError") {
        return reply.code(422).send(errBody("invalid-callsign", err.message));
      }
      throw err;
    }
  });

  app.get("/api/session", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readBearer(req);
    if (token === null) {
      return reply.code(401).send(errBody("unauthenticated", "Missing bearer token"));
    }
    const profile = await loadSessionProfile(deps.repo, deps.sessionSecret, token, {
      nowMs: deps.claimDefaults.nowMs,
    });
    if (profile === null) {
      return reply.code(401).send(errBody("unauthenticated", "Token invalid or expired"));
    }
    return reply.code(200).send({
      playerId: profile.playerId,
      callsign: profile.callsign,
      credits: profile.credits,
      homeSystemId: profile.homeSystemId,
      shipId: profile.shipId,
      tokenExpiresAt: profile.tokenExpiresAt,
    });
  });

  // TASK-66: explicit revocation endpoint. Idempotent on already-revoked
  // tokens (returns 401), so a client that retries after a network blip
  // learns the session is gone without an error succeeding twice.
  app.post("/api/session/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readBearer(req);
    if (token === null) {
      return reply.code(401).send(errBody("unauthenticated", "Missing bearer token"));
    }
    const result = await revokeSession(deps.repo, deps.sessionSecret, token, {
      nowMs: deps.claimDefaults.nowMs,
    });
    if (!result.revoked) {
      return reply.code(401).send(errBody("unauthenticated", "Token invalid or already revoked"));
    }
    // 204 No Content per REST semantics for a successful DELETE-ish op.
    reply.code(204);
    return reply.send();
  });
}
