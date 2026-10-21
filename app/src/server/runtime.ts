/**
 * Server runtime assembly (TASK-18).
 *
 * `startRuntime()` performs the *entire* production boot sequence —
 * DB client + migrations, Fastify app, WS layer, galaxy router,
 * per-shard flush service, static client — and returns live handles
 * so callers can inspect the shard map (the load harness asserts the
 * 16-player cap through `runtime.router.stats()`), bind a caller-
 * chosen port, and shut everything down deterministically.
 *
 * `src/server/index.ts` is now a thin CLI wrapper around this module:
 * it builds the config from the environment, calls `startRuntime`,
 * and installs the SIGINT/SIGTERM handlers. The load harness
 * (`tests/load/harness.ts`) calls the SAME function with a temp-file
 * SQLite DB and `port: 0` (random port), so the load numbers are
 * measured against the real boot path rather than a hand-wired test
 * double.
 */
import type { FastifyInstance } from "fastify";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { ServerConfig } from "./config.js";
import { buildApp } from "./server.js";
import { attachWs, type WsHandle } from "./ws.js";
import { createDbClient, type DbClient } from "./db/client.js";
import { type sqliteSchema } from "./db/schema.sqlite.js";
import { type pgSchema } from "./db/schema.pg.js";
import { createRepository, type Repository } from "./db/repo.js";
import { buildAuthResolver, buildLogoutResolver } from "./auth/resolver.js";
import { ShardFlushService, DEFAULT_FLUSH_INTERVAL_MS } from "./shard/persist.js";
import { GalaxyRouter } from "./galaxy/router.js";
import { registerStaticClient } from "./static.js";
import { buildRouterJoinResolver } from "./galaxy/join-resolver.js";
import { buildRouterWarpResolver } from "./galaxy/warp-resolver.js";
import {
  buildPresenceBroadcaster,
  buildConnSender,
  createConnectionCloseHook,
} from "./galaxy/ws-router-bridge.js";

/** Options accepted by {@link startRuntime}. */
export interface RuntimeOptions {
  /** Fully-resolved config (the caller owns env interpretation). */
  config: ServerConfig;
  /** Stars in the generated galaxy. Defaults to 32 (production value). */
  galaxyStarCount?: number;
  /** Port to bind. `0` picks a random free port (used by the load harness). */
  port?: number;
  /** Host to bind. Defaults to `0.0.0.0` (production) / overridable. */
  host?: string;
  /**
   * Start the periodic shard-flush safety net (TASK-24). Defaults to
   * `true`; the load harness keeps it on so the file-backed SQLite DB
   * is exercised by the real flush path.
   */
  startFlusher?: boolean;
  /** Reap grace (ms) before an empty shard is flushed + reaped. */
  reapGraceMs?: number;
  /** Reap sweep interval (ms). */
  reapIntervalMs?: number;
}

/** Live handles returned by {@link startRuntime}. */
export interface Runtime {
  app: FastifyInstance;
  ws: WsHandle;
  router: GalaxyRouter;
  repo: Repository;
  flusher: ShardFlushService;
  db: DbClient;
  /** The address Fastify actually bound, e.g. `http://127.0.0.1:41234`. */
  address: string;
  /** The bound TCP port (resolved when `port: 0` was requested). */
  port: number;
  /**
   * Graceful shutdown: flush + reap every shard, stop the flush
   * timer, close every socket, close Fastify and the DB handle.
   * Idempotent.
   */
  close(): Promise<void>;
}

/**
 * Resolve the flush interval from `SHARD_FLUSH_INTERVAL_MS`. Falls
 * back to {@link DEFAULT_FLUSH_INTERVAL_MS} when the env var is
 * missing, empty, or unparseable.
 */
function readFlushIntervalMs(): number {
  const raw = process.env.SHARD_FLUSH_INTERVAL_MS;
  if (!raw) return DEFAULT_FLUSH_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FLUSH_INTERVAL_MS;
  return parsed;
}

/**
 * Boot the whole server. Resolves once the HTTP server is listening,
 * so the caller can immediately open WebSocket clients against it.
 */
export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { config } = options;
  const galaxyStarCount = options.galaxyStarCount ?? 32;
  const host = options.host ?? "0.0.0.0";

  const db = createDbClient(config);
  db.migrate();
  const repo = createRepository({
    driver: db.driver,
    db:
      db.driver === "sqlite"
        ? (db.db as BetterSQLite3Database<typeof sqliteSchema>)
        : (db.db as NodePgDatabase<typeof pgSchema>),
  });

  const app = await buildApp(config, {
    repo,
    sessionSecret: config.sessionSecret,
    galaxySeed: config.galaxySeed,
    galaxyStarCount,
  });

  // Real WS auth resolver — callsign + token resolution against the
  // live repository and SESSION_SECRET.
  const authResolver = buildAuthResolver(repo, config.sessionSecret, {
    galaxySeed: config.galaxySeed,
    galaxyStarCount,
  });
  // TASK-66: real logout resolver — deletes every session row.
  const logoutResolver = buildLogoutResolver(repo);

  // Attach the WS layer BEFORE the router so the live
  // `ConnectionRegistry` is available to the presence broadcaster.
  const ws = attachWs(app, config.wsPath, { authResolver, logoutResolver });

  const router = new GalaxyRouter({
    repo,
    galaxySeed: config.galaxySeed,
    galaxyStarCount,
    presenceBroadcaster: buildPresenceBroadcaster({ registry: ws.registry }),
    connSender: buildConnSender({ registry: ws.registry }),
    ...(options.reapGraceMs !== undefined ? { reapGraceMs: options.reapGraceMs } : {}),
    ...(options.reapIntervalMs !== undefined ? { reapIntervalMs: options.reapIntervalMs } : {}),
  });
  ws.setOnConnectionClose(createConnectionCloseHook({ router }));
  ws.setJoinResolver(buildRouterJoinResolver({ repo, router }));
  ws.setWarpResolver(
    buildRouterWarpResolver({
      repo,
      router,
      galaxySeed: config.galaxySeed,
      galaxyStarCount,
    }),
  );
  ws.setShardFor((conn) =>
    conn.systemId === null ? undefined : (router.get(conn.systemId) ?? undefined),
  );
  ws.setRepo(repo);
  ws.setPresenceRebroadcaster((systemId) => {
    router.broadcastPresenceForSystem(systemId);
  });

  // Routes that need live handles are registered AFTER buildApp
  // returns (buildApp is intentionally not re-called).
  const { registerGalaxyHealthRoute } = await import("./routes/galaxy-health.js");
  registerGalaxyHealthRoute(app, {
    repo,
    sessionSecret: config.sessionSecret,
    router,
  });
  const { registerGalaxyOverviewRoute } = await import("./routes/galaxy-overview.js");
  registerGalaxyOverviewRoute(app, {
    repo,
    sessionSecret: config.sessionSecret,
    galaxySeed: config.galaxySeed,
    galaxyStarCount,
    nowMs: undefined,
  });
  // TASK-40: dock sell endpoint — needs the live WS registry + router.
  const { registerSellRoute } = await import("./routes/sell.js");
  registerSellRoute(app, {
    repo,
    sessionSecret: config.sessionSecret,
    nowMs: undefined,
    connIdForPlayer: (playerId) => {
      for (const conn of ws.registry.values()) {
        if (conn.playerId === playerId) return conn.connId;
      }
      return null;
    },
    shardFor: (playerId) => {
      for (const conn of ws.registry.values()) {
        if (conn.playerId !== playerId) continue;
        if (conn.systemId === null) continue;
        return router.get(conn.systemId) ?? null;
      }
      return null;
    },
  });

  if (config.staticDir) {
    await registerStaticClient(app, config.staticDir);
  }

  // TASK-24: per-shard ship flush service (safety net for the router's
  // imperative reap-time flush).
  const flusher = new ShardFlushService(repo, { intervalMs: readFlushIntervalMs() });
  if (options.startFlusher !== false) {
    flusher.start(async () => {
      for (const stats of router.stats().shards) {
        const shard = router.get(stats.systemId);
        if (!shard) continue;
        try {
          await flusher.flushNow(shard);
        } catch (err) {
          app.log.error({ err, systemId: stats.systemId }, "interval flush failed");
        }
      }
    });
  }

  router.start();

  const address = await app.listen({ port: options.port ?? config.apiPort, host });
  const port = Number(new URL(address).port);

  let closed = false;
  return {
    app,
    ws,
    router,
    repo,
    flusher,
    db,
    address,
    port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await router.shutdown();
      } catch (err) {
        app.log.error({ err }, "runtime shutdown flush failed");
      }
      flusher.dispose();
      await ws.close();
      await app.close();
      if (db.driver === "sqlite") {
        db.close();
      } else {
        await db.close();
      }
    },
  };
}
