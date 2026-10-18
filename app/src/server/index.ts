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
import { GalaxyRouter } from "./galaxy/router.js";
import { buildRouterJoinResolver } from "./galaxy/join-resolver.js";
import { buildRouterWarpResolver } from "./galaxy/warp-resolver.js";
import {
  buildPresenceBroadcaster,
  buildConnSender,
  createConnectionCloseHook,
} from "./galaxy/ws-router-bridge.js";
import { DEFAULT_SHUTDOWN_WATCHDOG_MS } from "@shared/galaxy/constants.js";

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
    // router is registered AFTER buildApp returns so the
    // `/api/galaxy/health` route sees a live router instance —
    // see the post-build registration below.
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

  // Attach the WS layer first so the live `ConnectionRegistry` is
  // available when we build the router. The router's presence
  // broadcaster iterates the registry to push `presence` frames; we
  // can't construct the broadcaster before the registry exists.
  const ws = attachWs(app, serverConfig.wsPath, {
    authResolver,
    logoutResolver,
    // joinResolver + onConnectionClose are set below via the
    // setters exposed on `WsHandle` (TASK-12) — they need a router
    // instance, which we haven't built yet at this point.
  });

  // TASK-11: galaxy router — owns every in-process system shard.
  // Built AFTER the WS layer is attached so the router's presence
  // broadcaster can iterate the live `ConnectionRegistry` and push
  // `presence` frames to the right sockets.
  const router = new GalaxyRouter({
    repo,
    galaxySeed: serverConfig.galaxySeed,
    galaxyStarCount: 32,
    // TASK-12: real presence broadcaster wired into the live WS
    // registry. `buildPresenceBroadcaster` returns a function that
    // walks `registry.values()` and writes to sockets whose
    // `systemId` matches the broadcast's system.
    presenceBroadcaster: buildPresenceBroadcaster({ registry: ws.registry }),
    // TASK-16: per-connection frame sender. Wired into every
    // shard via `RouterOptions.connSender` so the chat pipeline
    // (and future per-connection broadcasts: combat, etc.) can push
    // frames to the right socket without taking a WS dependency.
    connSender: buildConnSender({ registry: ws.registry }),
  });
  // Wire the close hook so every socket close calls
  // `router.leaveSystem(systemId, connId)`. The setters exposed on
  // `WsHandle` keep the WS layer router-agnostic while the boot
  // path resolves the dependency after both pieces exist.
  ws.setOnConnectionClose(createConnectionCloseHook({ router }));
  // Replace the stub joinResolver with the router-aware one. The
  // resolver reads `router.joinSystem` so it sees the live shard
  // map; pre-attaching the router first ensures no joinSystem call
  // can race the broadcaster wiring.
  ws.setJoinResolver(buildRouterJoinResolver({ repo, router }));
  // TASK-8: warp resolver — inter-system travel. Same pattern as
  // the join resolver: the WS layer ships a stub until the router
  // exists, then swaps in the router-aware one. The warp resolver
  // additionally needs `galaxySeed` + `galaxyStarCount` so it can
  // compute the spawn gate (deterministic star position lookup
  // through `findStar`).
  ws.setWarpResolver(
    buildRouterWarpResolver({
      repo,
      router,
      galaxySeed: serverConfig.galaxySeed,
      galaxyStarCount: 32,
    }),
  );
  // TASK-16: chat pipeline needs to look up the shard a connection
  // belongs to so `onChat` can broadcast. The router exposes a
  // thin `get(systemId)` lookup; we resolve it via `conn.systemId`
  // (already populated by `onJoinSystem`).
  ws.setShardFor((conn) =>
    conn.systemId === null ? undefined : (router.get(conn.systemId) ?? undefined),
  );
  // TASK-34: pass the repository down to the inventory handlers
  // (pickup / drop / interact-registry deposit entries). Same
  // instance the boot created above so the load/save cycle hits
  // the same SQLite file or PG pool as the rest of the server.
  ws.setRepo(repo);
  // Register the health route now that the router exists.
  // (buildApp is intentionally not re-called; we register the route
  // directly here to avoid the double-listener cost.)
  // Import lazily to avoid the cycle.
  const { registerGalaxyHealthRoute } = await import("./routes/galaxy-health.js");
  registerGalaxyHealthRoute(app, {
    repo,
    sessionSecret: serverConfig.sessionSecret,
    router,
  });
  // TASK-7: galaxy overview endpoint — chart payload (every star +
  // chart position + warp edges). Cached in-process; bearer-gated.
  const { registerGalaxyOverviewRoute } = await import("./routes/galaxy-overview.js");
  registerGalaxyOverviewRoute(app, {
    repo,
    sessionSecret: serverConfig.sessionSecret,
    galaxySeed: serverConfig.galaxySeed,
    galaxyStarCount: 32,
    nowMs: undefined,
  });

  // TASK-24: per-shard ship flush service. The interval cadence is
  // configurable via `SHARD_FLUSH_INTERVAL_MS` (default 30 s). The
  // router flushes imperatively on reap; the timer runs as a safety
  // net for any shard that survives longer than the reap grace.
  const flushIntervalMs = readFlushIntervalMs();
  const flusher = new ShardFlushService(repo, { intervalMs: flushIntervalMs });
  flusher.start(async () => {
    // Walk the router's live shards; the router's `stats()` returns
    // them in a flat list.
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

  // TASK-11: start the router's reap loop after wiring the rest of
  // the boot path so a premature SIGTERM during boot still hits the
  // graceful-shutdown block above.
  router.start();

  await app.listen({ port: serverConfig.apiPort, host: "0.0.0.0" });
  app.log.info(
    { port: serverConfig.apiPort, wsPath: serverConfig.wsPath, clientPort: serverConfig.port },
    "drift server listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    // TASK-12: install a watchdog so a misbehaving flush can't
    // hang the process forever. The Kubernetes default
    // terminationGracePeriodSeconds is 30 s, but 10 s is plenty
    // for a 16-shard flush (p95 ≈ 7 ms per shard) and a chance to
    // log the offender before we force-exit.
    const watchdog = setTimeout(() => {
      app.log.error(
        { signal, watchdogMs: DEFAULT_SHUTDOWN_WATCHDOG_MS },
        "shutdown watchdog fired — force exiting with code 1",
      );
      process.exit(1);
    }, DEFAULT_SHUTDOWN_WATCHDOG_MS);
    if (typeof watchdog.unref === "function") watchdog.unref();
    try {
      // TASK-11 graceful-shutdown flush: reap every shard once more
      // (with `force: true`) so ship positions survive a subsequent
      // kill. The router's `shutdown()` runs the flush + stop.
      app.log.info({ signal }, "flushing shards before shutdown");
      await router.shutdown();
      flusher.dispose();
      await ws.close();
      await app.close();
      if (client.driver === "sqlite") {
        (client as { close: () => void }).close();
      } else if (client.driver === "postgres") {
        await (client as { close: () => Promise<void> }).close();
      }
    } finally {
      clearTimeout(watchdog);
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
