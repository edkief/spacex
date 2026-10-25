import { FastifyInstance } from 'fastify';
import { router } from '../galaxy';
import { authMiddleware } from '../middleware/auth';
import { getGalaxyOverview } from '../galaxy/galaxy-overview';

export async function galaxyRoutes(fastify: FastifyInstance) {
  fastify.get('/api/galaxy/overview', async (request, reply) => {
    return getGalaxyOverview();
  });

  fastify.get(
    '/api/galaxy/health',
    {
      preHandler: [authMiddleware],
    },
    async (request, reply) => {
      return {
        ...router.getStats(),
      };
    },
  );
}
