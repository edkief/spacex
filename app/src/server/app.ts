import Fastify from 'fastify';
import dotenv from 'dotenv';
import path from 'path';
import { WebSocketServer } from 'ws';

// Load environment variables from PROJECT_ROOT/.env.local
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const PORT = Number(process.env.PORT) || 8080;
const WS_PATH = process.env.WS_PATH || '/ws';
const GALAXY_SEED = process.env.GALAXY_SEED || 'default-seed';

const fastify = Fastify({ logger: false });

// Health check endpoint
fastify.get('/api/health', async (request, reply) => {
  return { ok: true, galaxySeed: GALAXY_SEED };
});

export { fastify, GALAXY_SEED };
