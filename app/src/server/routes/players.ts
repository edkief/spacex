/**
 * REST routes for authenticated player self-service (TASK-41).
 *
 *   GET /api/players/me
 *     header: Authorization: Bearer <token>
 *     200:  { callsign, credits, homeSystemId, shipId }
 *     401:  { code: "unauthenticated", message }
 *
 * Only the *caller's* profile is exposed; there is no
 * `GET /api/players/:id` endpoint in v1 (PRD §6 — no PvP market, no
 * leaderboard). Adding one later would require a separate privacy
 * review.
 *
 * Implementation shares the bearer-token parser with
 * `./callsigns.ts`; we re-implement it here rather than reach across
 * modules so the route file is self-contained.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { Repository } from "../db/repo.js";
import { loadSessionProfile } from "../auth/resolver.js";

/** Public deps shared by tests and the live server. */
export interface PlayersDeps {
  repo: Repository;
  sessionSecret: string;
  /** Override the wall clock for tests (epoch ms). */
  nowMs?: number;
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
 * Register the player self-service handlers on the given Fastify instance.
 *
 * `buildApp()` is the only intended caller; tests wrap their own Fastify
 * + deps and call this directly so they can supply an in-memory repo.
 */
export function registerPlayersRoutes(app: FastifyInstance, deps: PlayersDeps): void {
  app.get("/api/players/me", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readBearer(req);
    if (token === null) {
      return reply.code(401).send(errBody("unauthenticated", "Missing bearer token"));
    }
    const profile = await loadSessionProfile(deps.repo, deps.sessionSecret, token, {
      nowMs: deps.nowMs,
    });
    if (profile === null) {
      return reply.code(401).send(errBody("unauthenticated", "Token invalid or expired"));
    }
    return reply.code(200).send({
      callsign: profile.callsign,
      credits: profile.credits,
      homeSystemId: profile.homeSystemId,
      shipId: profile.shipId,
    });
  });
}
