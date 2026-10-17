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
import { createDbClient } from "./db/client.js";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type sqliteSchema } from "./db/schema.sqlite.js";
import { type pgSchema } from "./db/schema.pg.js";
import { createRepository } from "./db/repo.js";
import { assertValidSecret } from "./auth/token.js";
import { buildAuthResolver } from "./auth/resolver.js";

async function main(): Promise<void> {
  // The token codec requires a real SESSION_SECRET. Refuse to boot if
  // it's missing or too short — silent fallback would ship a
  // forgeable auth path.
  assertValidSecret(serverConfig.sessionSecret);

  const client = createDbClient(serverConfig);
  client.migrate();
  const repo = createRepository({
    driver: client.driver,
    db:
      client.driver === "sqlite"
        ? (client as { db: BetterSQLite3Database<typeof sqliteSchema> }).db
        : (client as { db: NodePgDatabase<typeof pgSchema> }).db,
  });

  const app = await buildApp(serverConfig, {
    repo,
    sessionSecret: serverConfig.sessionSecret,
    galaxySeed: serverConfig.galaxySeed,
    galaxyStarCount: 32,
  });

  // Real WS auth resolver — wire callsign + token resolution against
  // the live repository and SESSION_SECRET. The previous TASK-9 stub
  // accepted any callsign and synthesised a deterministic id.
  const authResolver = buildAuthResolver(repo, serverConfig.sessionSecret, {
    galaxySeed: serverConfig.galaxySeed,
    galaxyStarCount: 32,
  });
  const ws = attachWs(app, serverConfig.wsPath, { authResolver });

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
      if (client.driver === "sqlite") {
        (client as { close: () => void }).close();
      } else if (client.driver === "postgres") {
        await (client as { close: () => Promise<void> }).close();
      }
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
