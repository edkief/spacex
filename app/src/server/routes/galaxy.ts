import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth';
import type { SessionService } from '@server/auth/session';
import type { GalaxyRouter } from '@server/galaxy/router';
import type { GalaxyHealthPayload } from '@shared/health';

/**
 * GET /api/galaxy/health (auth, TASK-11): read-only list of the router's
 * active shards — {systemId, name, players, uptimeMs} each. Cheap (one map
 * read, no DB), used by the chart UI occupancy dots (TASK-7).
 */
export function registerGalaxyRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionService; router: GalaxyRouter },
): void {
  app.get('/api/galaxy/health', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const payload: GalaxyHealthPayload = { shards: deps.router.stats() };
    return payload;
  });
}
