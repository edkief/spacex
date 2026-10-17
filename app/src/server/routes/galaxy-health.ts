/**
 * `GET /api/galaxy/health` — TASK-11.
 *
 * Returns the live router stats: every active shard with its
 * systemId, display name, current player count, and uptime. The
 * chart UI (TASK-7) consumes this to render occupancy dots per
 * star, and the maintenance dashboard uses the same shape to
 * diagnose stuck shards.
 *
 * Auth: bearer-token gated. The same auth dependency the callsign
 * routes use is reused so the health endpoint is not a leak in
 * unattended deployments.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     galaxySeed: "DRIFT-...",
 *     shards: [{ systemId, name, players, uptimeMs }],
 *     shardCount: number,
 *     totalPlayers: number,
 *     routerStartedAt: number
 *   }
 *
 * Read-only, cheap (one Map iteration + a couple of `Date.now()`
 * arithmetic ops). Safe to poll at any cadence.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { Repository } from "../db/repo.js";
import { loadSessionProfile } from "../auth/resolver.js";
import type { GalaxyRouter } from "../galaxy/router.js";

/** Public deps shared by tests + the live server. */
export interface GalaxyHealthDeps {
  repo: Repository;
  sessionSecret: string;
  router: GalaxyRouter;
  /** Optional clock override (epoch ms). */
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
 * Register the `GET /api/galaxy/health` route. Caller wires the
 * `{repo, sessionSecret, router}` dependencies; tests provide their
 * own Fastify + the test repo so the live route can be exercised
 * without booting the full stack.
 */
export function registerGalaxyHealthRoute(app: FastifyInstance, deps: GalaxyHealthDeps): void {
  app.get("/api/galaxy/health", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readBearer(req);
    if (token === null) {
      return reply.code(401).send(errBody("unauthenticated", "Missing bearer token"));
    }
    // Cheap auth check — no DB writes, just session lookup. We refuse
    // anon callers so the endpoint doesn't leak chart data to
    // unauthenticated clients.
    const profile = await loadSessionProfile(deps.repo, deps.sessionSecret, token, {
      nowMs: deps.nowMs,
    });
    if (!profile) {
      return reply.code(401).send(errBody("unauthenticated", "Token invalid or expired"));
    }
    const stats = deps.router.stats();
    return reply.code(200).send({
      ok: true,
      galaxySeed: profile.homeSystemId !== null ? "configured" : "default",
      shards: stats.shards,
      shardCount: stats.shardCount,
      totalPlayers: stats.totalPlayers,
      routerStartedAt: stats.routerStartedAt,
    });
  });
}
