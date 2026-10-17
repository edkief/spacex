/**
 * WebSocket upgrade handler for the Drift server.
 *
 * Attaches a `ws.Server` to a Fastify HTTP server. The full protocol lives
 * in `@shared/ws-protocol` (TASK-9); for now we only echo a hello frame
 * so smoke tests can verify the upgrade end-to-end.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { FastifyInstance } from "fastify";

export interface WsHandle {
  /** Underlying `ws.Server`; exposed for tests and graceful shutdown. */
  wss: WebSocketServer;
  /** Close every active socket and stop accepting new ones. */
  close: () => Promise<void>;
}

/**
 * Attach a `ws.Server` to `app.server.httpServer` on `wsPath`.
 *
 * Returns a handle whose `close()` resolves once every socket has been
 * terminated, so the caller can `await` it during graceful shutdown.
 */
export function attachWs(app: FastifyInstance, wsPath: string): WsHandle {
  if (!app.server) {
    throw new Error("Fastify app is not listening; cannot attach WebSocket server.");
  }
  const wss = new WebSocketServer({ noServer: true });

  app.server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    if (!url.startsWith(wsPath)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "hello", t: Date.now() }));
    ws.on("error", () => {
      // Swallow per-socket errors; the server keeps running. Detailed
      // logging will land with TASK-9 (protocol + handshake).
    });
  });

  return {
    wss,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}
