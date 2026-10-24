import Fastify from 'fastify';
import dotenv from 'dotenv';
import path from 'path';
import { callsignRoutes } from './routes/callsigns';
import { sessionRoutes } from './routes/session';

// Load environment variables from PROJECT_ROOT/.env.local
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const GALAXY_SEED = process.env.GALAXY_SEED || 'default-seed';

export function createApp() {
  const fastify = Fastify({ logger: false });

  // Register routes
  callsignRoutes(fastify);
  sessionRoutes(fastify);

  // Health check endpoint
  fastify.get('/api/health', async () => {
    return { ok: true, galaxySeed: GALAXY_SEED };
  });

  return fastify;
}

export { GALAXY_SEED };
