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
import { buildAuthResolver, buildLogoutResolver } from "./auth/resolver.js";
import { ShardFlushService, DEFAULT_FLUSH_INTERVAL_MS } from "./shard/persist.js";
import { ShardRegistry } from "./shard/registry.js";

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
  // TASK-66: real logout resolver — deletes every session row for the
  // player. Wired through so the WS `logout` message actually revokes.
  const logoutResolver = buildLogoutResolver(repo);
  const ws = attachWs(app, serverConfig.wsPath, { authResolver, logoutResolver });

  // TASK-24: per-shard ship flush service. The interval cadence is
  // configurable via `SHARD_FLUSH_INTERVAL_MS` (default 30 s) so the
  // crash-restart integration test can shorten the cycle. Today the
  // registry is empty — the future TASK-11 router will populate it as
  // players join systems; the timer is wired now so the SIGTERM
  // graceful-shutdown flush path is exercised from boot.
  const flushIntervalMs = readFlushIntervalMs();
  const registry = new ShardRegistry(repo);
  const flusher = new ShardFlushService(repo, { intervalMs: flushIntervalMs });
  flusher.start(async () => {
    await registry.flushAll();
  });

  await app.listen({ port: serverConfig.apiPort, host: "0.0.0.0" });
  app.log.info(
    { port: serverConfig.apiPort, wsPath: serverConfig.wsPath, clientPort: serverConfig.port },
    "drift server listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      // TASK-24 graceful-shutdown flush: write every live ship's state
      // to the DB before we tear down the WS / HTTP layers. The 30 s
      // interval is too coarse to guarantee a flush within the SIGTERM
      // window, so we run one final pass here.
      app.log.info({ signal }, "flushing shards before shutdown");
      await registry.flushAll();
      flusher.dispose();
      registry.shutdownAll();
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

/**
 * Resolve the flush interval from `SHARD_FLUSH_INTERVAL_MS`. Falls
 * back to `DEFAULT_FLUSH_INTERVAL_MS` when the env var is missing,
 * empty, or unparseable. The crash-restart integration test sets a
 * shorter value (e.g. 200 ms) so a single kill cycle exercises the
 * flush path.
 */
function readFlushIntervalMs(): number {
  const raw = process.env.SHARD_FLUSH_INTERVAL_MS;
  if (!raw) return DEFAULT_FLUSH_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FLUSH_INTERVAL_MS;
  }
  return parsed;
}

main().catch((err: unknown) => {
  // Surface the error then exit with a non-zero code so `tsx watch` respawns.
  console.error("[drift-server] fatal:", err);
  process.exit(1);
});
