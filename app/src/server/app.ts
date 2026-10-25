import Fastify from 'fastify';
import dotenv from 'dotenv';
import path from 'path';
import { callsignRoutes } from './routes/callsigns';
import { sessionRoutes } from './routes/session';
import { playersRoutes } from './routes/players';
import { shipsRoutes } from './routes/ships';
import { galaxyRoutes } from './routes/galaxy';

import { DEFAULT_GALAXY_SEED } from '../shared/galaxy/config';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const GALAXY_SEED = process.env.GALAXY_SEED || DEFAULT_GALAXY_SEED;

export function createApp(options: { logger?: any } = {}) {
  const fastify = Fastify({ logger: options.logger ?? false });

  // Register routes
  callsignRoutes(fastify);
  sessionRoutes(fastify);
  playersRoutes(fastify);
  shipsRoutes(fastify);
  galaxyRoutes(fastify);

  // Health check endpoint
  fastify.get('/api/health', async () => {
    return { ok: true, galaxySeed: GALAXY_SEED };
  });

  return fastify;
}

export { GALAXY_SEED };
