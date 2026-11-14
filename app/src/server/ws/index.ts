import type { FastifyInstance } from 'fastify';
import { WebSocket as WsSocket, WebSocketServer, type RawData } from 'ws';
import { MAX_FRAME_BYTES } from '@shared/protocol/envelope.ts';
import { CLOSE_CODES, errorBody } from '@shared/protocol/errors.ts';
import { clientIp } from '../clientIp.ts';
import { Connection } from './connection.ts';
import type { WsDeps } from './context.ts';
import { createDispatcher, rejectBinary, type HandlerMap } from './dispatch.ts';
import { chatHandlers } from './chat.ts';
import { sessionHandlers } from './handlers.ts';
import { armHandshakeTimeout, startHeartbeat } from './heartbeat.ts';
import { Hub } from './hub.ts';
import { admitFrame } from './limits.ts';

export interface WebSocketLayer {
  hub: Hub;
  wss: WebSocketServer;
}

/** Joins ws message data (a Buffer for text frames) into a UTF-8 string. */
function frameText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/**
 * Attaches the WebSocket protocol layer to the Fastify HTTP server at `config.wsPath`.
 * `maxPayload` makes the ws library refuse frames over 64 KB before buffering them.
 */
export function attachWebSocket(
  app: FastifyInstance,
  deps: WsDeps,
  handlers: HandlerMap = { ...sessionHandlers, ...chatHandlers },
): WebSocketLayer {
  const hub = new Hub();
  const dispatch = createDispatcher(handlers, deps, hub);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  const stopHeartbeat = startHeartbeat(deps, hub);

  app.server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname !== deps.config.wsPath) {
      socket.destroy();
      return;
    }
    const ip = clientIp(request, deps.config.trustProxy);
    if (!hub.ipLimiter.acquire(ip)) {
      const body = JSON.stringify(errorBody('too-many-connections', 'too many connections'));
      socket.end(
        `HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      return;
    }
    // The raw TCP socket closes on every path (refused handshake, normal close, terminate).
    socket.once('close', () => hub.ipLimiter.release(ip));
    wss.handleUpgrade(request, socket, head, (client) =>
      wss.emit('connection', client, request, ip),
    );
  });

  wss.on('connection', (socket: WsSocket, _request: unknown, ip: string) => {
    const conn = new Connection(
      {
        get open() {
          return socket.readyState === WsSocket.OPEN;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        terminate: () => socket.terminate(),
      },
      ip,
      deps.clock,
    );
    hub.add(conn);
    armHandshakeTimeout(conn, deps);

    socket.on('error', (error) => deps.log.warn({ err: error }, 'websocket error'));
    socket.on('message', (data, isBinary) => {
      // Rate limiting happens before queueing so a flood can never build a backlog.
      if (!admitFrame(conn)) return;
      if (isBinary) {
        rejectBinary(conn, deps);
        return;
      }
      void conn.enqueue(() =>
        conn.dropping ? Promise.resolve() : dispatch(conn, frameText(data)),
      );
    });
    socket.on('close', () => {
      const { systemId, session } = conn;
      hub.remove(conn);
      conn.markClosed();
      if (systemId && session) void deps.directory.leave(systemId, session.playerId);
    });
  });

  app.addHook('preClose', async () => {
    stopHeartbeat();
    for (const conn of [...hub.connections()]) conn.close(CLOSE_CODES.serverShutdown, 'shutdown');
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  return { hub, wss };
}
