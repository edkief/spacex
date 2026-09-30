import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth';
import type { SessionService } from '@server/auth/session';
import type { GalaxyRouter } from '@server/galaxy/router';
import type { GalaxyHealthPayload } from '@shared/health';
import { galaxyChart, type ChartSystem } from '@shared/galaxy/chart';

/**
 * GET /api/galaxy/health (auth, TASK-11): read-only list of the router's
 * active shards — {systemId, name, players, uptimeMs} each. Cheap (one map
 * read, no DB), used by the chart UI occupancy dots (TASK-7).
 */
export function registerGalaxyRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionService; router: GalaxyRouter; galaxySeed: string },
): void {
  app.get('/api/galaxy/health', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const payload: GalaxyHealthPayload = { shards: deps.router.stats() };
    return payload;
  });

  /**
   * GET /api/galaxy/overview (auth, TASK-7): the star chart data —
   * {seed, systems: [{systemId, name, starClass, pos2D, neighbors}]} — the
   * player's current system (?home=, defaults to their home system) plus its
   * two nearest seeded neighbours, with light-second distances + warp times.
   * Cheap seeded derivation (no DB) — cached in-process forever, keyed by
   * (seed, home): the seed never changes at runtime.
   */
  app.get('/api/galaxy/overview', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const q = req.query as { home?: unknown };
    const home =
      typeof q.home === 'string' && /^[0-9a-f]{16}$/i.test(q.home)
        ? q.home.toLowerCase()
        : auth.player.homeSystemId;
    const key = `${deps.galaxySeed}:${home}`;
    let systems = overviewCache.get(key);
    if (!systems) {
      systems = galaxyChart(deps.galaxySeed, home);
      overviewCache.set(key, systems);
    }
    return { seed: deps.galaxySeed, systems };
  });
}

/** In-process forever cache: the seed never changes at runtime. */
const overviewCache = new Map<string, ChartSystem[]>();

/** Test helper: drop the overview cache (new seed, fresh assertions). */
export function clearOverviewCache(): void {
  overviewCache.clear();
}
