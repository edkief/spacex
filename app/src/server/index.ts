/**
 * Drift server entry point.
 *
 * Reads config from `.env.local`, builds the Fastify app, attaches the
 * WebSocket server, and listens on `config.apiPort` (defaults to
 * `config.port + 1` so the Fastify server and the Vite dev server don't
 * collide on `PORT=3000`). `tsx watch` invokes this file during
 * `npm run dev`; production launches it via `node dist/server/index.js`
 * (TASK-69).
 *
 * Graceful shutdown closes both the HTTP server and the ws handle so the
 * process exits cleanly when killed by `tsx`/CI.
 */
import { serverConfig } from "./config.js";
import { buildApp } from "./server.js";
import { attachWs } from "./ws.js";

async function main(): Promise<void> {
  const app = await buildApp(serverConfig);
  const ws = attachWs(app, serverConfig.wsPath);

  await app.listen({ port: serverConfig.apiPort, host: "0.0.0.0" });
  app.log.info(
    { port: serverConfig.apiPort, wsPath: serverConfig.wsPath, clientPort: serverConfig.port },
    "drift server listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await ws.close();
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  // Surface the error then exit with a non-zero code so `tsx watch` respawns.
  console.error("[drift-server] fatal:", err);
  process.exit(1);
});
