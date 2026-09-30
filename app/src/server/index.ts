import { loadEnv } from '@server/env';
import { buildServer } from '@server/server';
import { attachWebSocket } from '@server/ws';
import { getDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { pgTables, sqliteTables } from '@server/db/schema';
import { createSessionService, createTokenAuthenticate } from '@server/auth/session';
import { createTokenCodec } from '@server/auth/token';
import { registerApiRoutes } from '@server/routes';
import { attachShipSwapBroadcast, createShipSwapBus } from '@server/shards';
import { createGalaxyRouter } from '@server/galaxy/router';
import { createRouterGateway } from '@server/galaxy/gateway';
import type { InputPayload } from '@shared/protocol/schemas';

const env = loadEnv();
const app = buildServer(env);

/**
 * Process entry (TASK-11): the galaxy router hosts any number of system
 * shards in-process — a shard spawns when a player joins its system
 * (system data from GALAXY_SEED, ships rehydrated via TASK-24), is reaped
 * 60 s after it empties (ships flushed first), and is capped at 16 players.
 * SIGTERM/SIGINT stop every shard with a final flush before exiting.
 */
async function main(): Promise<void> {
  const dbHandle = getDb();
  const repo = createRepo(dbHandle.db, dbHandle.driver === 'sqlite' ? sqliteTables : pgTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec(env.SESSION_SECRET) });
  const shipSwapBus = createShipSwapBus();

  const router = createGalaxyRouter({
    repo,
    galaxySeed: env.GALAXY_SEED,
    shipSwapBus,
    log: {
      debug: (msg, meta) => app.log.debug(meta, msg),
      warn: (msg, meta) => app.log.warn(meta, msg),
      info: (msg, meta) => app.log.info(meta, msg),
    },
  });
  const stopReaper = router.startReaper();
  // 30 s (env) flush cadence (PRD §8): a SIGKILL loses at most one period.
  const stopFlushing = router.startPeriodicFlush(env.SHARD_FLUSH_INTERVAL_MS);

  registerApiRoutes(app, {
    repo,
    sessions,
    galaxySeed: env.GALAXY_SEED,
    shipSwapBus,
    galaxyRouter: router,
  });
  const wsHandle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: createRouterGateway(router),
    authenticate: createTokenAuthenticate(sessions),
    revokeToken: (token) => sessions.revoke(token),
    onGameMessage: (conn, type, payload) => {
      // Gameplay frames route to the shard the connection is currently in.
      if (!conn.systemId || !conn.playerId) return;
      const shard = router.active(conn.systemId)?.shard;
      if (!shard) return;
      // 'input': the tick drains the queue. The Conn identity lets the
      // shard drop frames from a superseded (zombie) socket (TASK-17).
      if (type === 'input') {
        shard.enqueueInput(conn.playerId, payload as InputPayload, conn);
        return;
      }
      // 'chat' (TASK-16): validated + rate-limited upstream; the shard
      // assigns ts and broadcasts to the whole system.
      if (type === 'chat' && conn.callsign) {
        shard.handleChat(conn.callsign, (payload as { text: string }).text);
      }
    },
    // Leaves route through the gateway's leaveSystem → router.leave,
    // which starts the reap grace when a shard empties.
  });
  // TASK-20: dock purchases swap the ship entity in-place for any peer in-system.
  attachShipSwapBroadcast(shipSwapBus, wsHandle.connections, repo);

  // Graceful shutdown (TASK-12): stop the reaper, stop + flush every active
  // shard (so a SIGTERM loses nothing), then close cleanly with exit code 0.
  // A 10 s watchdog force-exits with code 1 if the flushes hang — a wedge
  // must not hold the process (and its DB writes) open forever.
  const SHUTDOWN_WATCHDOG_MS = 10_000;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const watchdog = setTimeout(() => {
      app.log.error(
        { signal, watchdogMs: SHUTDOWN_WATCHDOG_MS },
        'graceful shutdown exceeded the watchdog; forcing exit',
      );
      process.exit(1);
    }, SHUTDOWN_WATCHDOG_MS);
    watchdog.unref?.();
    app.log.info({ signal }, 'graceful shutdown: flushing shards');
    stopReaper();
    stopFlushing();
    try {
      await router.stopAll();
      app.log.info('final shard flushes done');
    } catch (err) {
      app.log.error({ err }, 'final shard flush failed');
    } finally {
      clearTimeout(watchdog);
    }
    await wsHandle.close().catch(() => {});
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
  app.log.info({ port: env.PORT, wsPath: env.WS_PATH }, 'server listening');
}

void main();
