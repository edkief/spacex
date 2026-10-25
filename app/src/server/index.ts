import { createApp } from './app';
import dotenv from 'dotenv';
import path from 'path';
import { WebSocketServer } from 'ws';
import { setupWebSocketHandler } from './ws';
import { router } from './galaxy';
import { persistService } from './persist';
import { closeDb, migrate } from './db/client';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const PORT = Number(process.env.PORT) || 8080;
const WS_PATH = process.env.WS_PATH || '/ws';

const start = async () => {
  try {
    await migrate();
    const fastify = createApp({ logger: true });
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server listening on port ${PORT}`);

    const wss = new WebSocketServer({ server: fastify.server });
    setupWebSocketHandler(wss);
    console.log(`WebSocket server listening on ${WS_PATH}`);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down...`);

      const watchdog = setTimeout(() => {
        console.error('Shutdown timed out after 10s. Forcing exit 1.');
        process.exit(1);
      }, 10000);

      try {
        await router.shutdownAll();
        await closeDb();
        await fastify.close();
        console.log('Server closed gracefully');
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
      } finally {
        clearTimeout(watchdog);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
