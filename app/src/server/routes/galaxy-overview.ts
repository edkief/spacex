/**
 * `GET /api/galaxy/overview` — TASK-7.
 *
 * Returns the deterministic chart payload (every star, its chart
 * position, and its nearest-neighbour warp edges). Drives the
 * in-game star chart UI. The endpoint is bearer-token gated so the
 * chart's geometry is not leaked to anonymous clients.
 *
 * The payload is built once per `(seed, starCount)` pair and cached
 * in-process for the server's lifetime — `buildGalaxyOverview` is
 * pure and the seed never changes at runtime. A per-request
 * `currentSystemId` is filled in from the caller's session so the
 * chart can highlight "you are here".
 *
 * Response shape:
 *   {
 *     ok: true,
 *     overview: GalaxyOverview
 *   }
 *
 * The `overview` object carries:
 *   - `galaxySeed`  — echoed seed (for the chart's header label).
 *   - `viewBoxWidth/Height` — chart viewport dimensions.
 *   - `systems`     — every system with chart position + neighbours.
 *   - `currentSystemId` — caller's current system or `null`.
 *
 * Read-only, cheap (one Map iteration after cache hit). Safe to
 * poll at any cadence — the chart's occupancy overlay polls every
 * 5 s; this endpoint is polled separately for geometry and is
 * much cheaper than a `/api/galaxy/health` call because it has no
 * router overhead.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { Repository } from "../db/repo.js";
import { loadSessionProfile } from "../auth/resolver.js";
import { buildGalaxyOverview, type GalaxyOverview } from "@shared/galaxy/overview.js";

/** Public deps shared by tests + the live server. */
export interface GalaxyOverviewDeps {
  repo: Repository;
  sessionSecret: string;
  galaxySeed: string;
  galaxyStarCount: number;
  /** Optional wall-clock override (epoch ms) — used by tests. */
  nowMs?: number;
}

/** Cache entry — one per `(seed, starCount)`. */
interface CachedOverview {
  /** The payload (without `currentSystemId` — that is per-request). */
  base: Omit<GalaxyOverview, "currentSystemId">;
}

/** Module-level cache (one process, one galaxy). */
let cache: CachedOverview | null = null;
/** Cached inputs (so we can detect a config change and rebuild). */
let cachedInputs: { seed: string; starCount: number } | null = null;

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
 * Get (or build) the cached overview payload for `(seed, starCount)`.
 *
 * The cache key is `(seed, starCount)`; a change to either input
 * forces a rebuild. Returns the **base** payload (no
 * `currentSystemId`); the caller fills in that field per request.
 */
function getCachedOverview(
  seed: string,
  starCount: number,
): Omit<GalaxyOverview, "currentSystemId"> {
  if (
    cache !== null &&
    cachedInputs !== null &&
    cachedInputs.seed === seed &&
    cachedInputs.starCount === starCount
  ) {
    return cache.base;
  }
  const built = buildGalaxyOverview(seed, starCount);
  // Strip the per-request field before caching.
  const { currentSystemId: _omit, ...rest } = built;
  void _omit;
  const base = rest;
  cache = { base };
  cachedInputs = { seed, starCount };
  return base;
}

/**
 * Test-only: clear the in-process overview cache. Used by tests
 * that run with different seed inputs in the same process.
 */
export function _resetOverviewCacheForTests(): void {
  cache = null;
  cachedInputs = null;
}

/**
 * Register the `GET /api/galaxy/overview` route. The caller wires
 * `{repo, sessionSecret, galaxySeed, galaxyStarCount}`; tests
 * provide their own Fastify + repo so the live route can be
 * exercised without booting the full stack.
 */
export function registerGalaxyOverviewRoute(app: FastifyInstance, deps: GalaxyOverviewDeps): void {
  app.get("/api/galaxy/overview", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readBearer(req);
    if (token === null) {
      return reply.code(401).send(errBody("unauthenticated", "Missing bearer token"));
    }
    const profile = await loadSessionProfile(deps.repo, deps.sessionSecret, token, {
      nowMs: deps.nowMs,
    });
    if (!profile) {
      return reply.code(401).send(errBody("unauthenticated", "Token invalid or expired"));
    }
    const base = getCachedOverview(deps.galaxySeed, deps.galaxyStarCount);
    // Fill in the per-request "current system" field. The
    // `SessionProfile` only carries the player's home system id
    // (the active session's *current* system isn't tracked by
    // the REST auth layer); the client overlays the live
    // `currentSystemId` from the WS state on top of the
    // overview payload.
    const currentSystemId = profile.homeSystemId ?? null;
    return reply.code(200).send({
      ok: true,
      overview: {
        ...base,
        currentSystemId,
      },
    });
  });
}
