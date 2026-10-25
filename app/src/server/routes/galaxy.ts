import { FastifyInstance } from 'fastify';
import { router } from '../galaxy';
import { authMiddleware } from '../middleware/auth';

export async function galaxyRoutes(fastify: FastifyInstance) {
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
