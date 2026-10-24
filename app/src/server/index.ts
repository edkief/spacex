import { fastify } from './app';
import dotenv from 'dotenv';
import path from 'path';
import { WebSocketServer } from 'ws';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const PORT = Number(process.env.PORT) || 8080;
const WS_PATH = process.env.WS_PATH || '/ws';

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server listening on port ${PORT}`);

    const wss = new WebSocketServer({ server: fastify.server });
    wss.on('connection', (ws) => {
      console.log('Client connected via WebSocket');
      ws.send('Welcome to the galaxy!');
    });
    console.log(`WebSocket server listening on ${WS_PATH}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
