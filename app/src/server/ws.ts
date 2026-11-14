import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';

/**
 * Attaches a ws server to the Fastify HTTP server at `wsPath`. Upgrades for any other path are
 * rejected. For now it only answers a text `ping` with `pong`; the real protocol comes later.
 * Open sockets are terminated before Fastify closes so shutdown never hangs.
 */
export function attachWebSocket(app: FastifyInstance, wsPath: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname !== wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });

  wss.on('connection', (client) => {
    client.on('error', (error) => app.log.warn({ err: error }, 'websocket client error'));
    client.on('message', (data, isBinary) => {
      if (!isBinary && Buffer.isBuffer(data) && data.toString('utf8') === 'ping')
        client.send('pong');
    });
  });

  app.addHook('preClose', async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  return wss;
}
