import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { loadEnv } from '@server/env';
import { buildServer } from '@server/server';

const env = loadEnv();
const app = buildServer(env);

// Upgrade handling for the ws connection at env.WS_PATH.
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'welcome' }));
});

app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== env.WS_PATH) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
