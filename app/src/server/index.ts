import { createApp } from './app';
import dotenv from 'dotenv';
import path from 'path';
import { WebSocketServer } from 'ws';
import { setupWebSocketHandler } from './ws';
import { shardManager } from './shard/manager';
import { persistService } from './persist';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const PORT = Number(process.env.PORT) || 8080;
const WS_PATH = process.env.WS_PATH || '/ws';

const start = async () => {
  try {
    const fastify = createApp();
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server listening on port ${PORT}`);

    const wss = new WebSocketServer({ server: fastify.server });
    setupWebSocketHandler(wss);
    console.log(`WebSocket server listening on ${WS_PATH}`);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down...`);
      
      // Flush all shards
      const shards = shardManager.getShards(); // Need to add this method to ShardManager
      await Promise.all(
        Array.from(shards.entries()).map(([systemId, shard]) => 
          persistService.onShardShutdown(systemId, shard)
        )
      );

      await fastify.close();
      console.log('Server closed');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
