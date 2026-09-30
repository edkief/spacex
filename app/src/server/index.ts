import { loadEnv } from '@server/env';
import { buildServer } from '@server/server';
import { attachWebSocket, createRegistryGateway } from '@server/ws';
import { getDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { pgTables, sqliteTables } from '@server/db/schema';
import { createSessionService, createTokenAuthenticate } from '@server/auth/session';
import { createTokenCodec } from '@server/auth/token';
import { registerApiRoutes } from '@server/routes';
import { attachShipSwapBroadcast, createShipSwapBus } from '@server/shards';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { SystemShard, createShardPersist, startShardFlushTimer } from '@server/shard';

const env = loadEnv();
const app = buildServer(env);

/**
 * Process entry. TASK-13 runs one test-only shard (the seed's first star
 * system) until the router (TASK-11) creates/reaps shards per system.
 * TASK-24: the shard loads its persisted ships on boot (no spawn teleports),
 * flushes them every SHARD_FLUSH_INTERVAL_MS (30 s), and does a final flush
 * on SIGTERM/SIGINT before exiting.
 */
async function main(): Promise<void> {
  const dbHandle = getDb();
  const repo = createRepo(dbHandle.db, dbHandle.driver === 'sqlite' ? sqliteTables : pgTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec(env.SESSION_SECRET) });
  const gateway = createRegistryGateway(repo);
  const shipSwapBus = createShipSwapBus();

  // Test-only single shard: the first star's system of the seed. It is
  // registered so dev clients can join it (the router does this per-system
  // in TASK-11/12).
  const firstStar = generateStars(env.GALAXY_SEED)[0];
  const simSystem = generateSystem(env.GALAXY_SEED, firstStar.id);
  await repo.upsertSystem(simSystem.systemId, simSystem.name, true);

  // TASK-24: shard flush + restart-load persistence.
  const shardPersist = createShardPersist({ repo, systemId: simSystem.systemId });

  const shard = new SystemShard({
    systemId: simSystem.systemId,
    galaxySeed: env.GALAXY_SEED,
    system: simSystem,
    repo,
    shipSwapBus,
    persist: (entities) => {
      // The stop() snapshot hook stays log-only; the authoritative final
      // write happens in the shutdown handler below (it must be async).
      app.log.debug({ count: entities.length }, 'shard persist (no-op)');
    },
  });

  // Load persisted state BEFORE ticking: flying ships resume at their last
  // saved position/velocity/rotation, docked ships at dock coords, and
  // unexpired wrecks come back static (expired wreck rows are deleted here).
  const load = await shardPersist.loadShips();
  await shard.loadShips(load);
  app.log.info(
    {
      systemId: simSystem.systemId,
      ships: load.ships.length,
      wrecks: load.wrecks.length,
      deletedExpired: load.deletedExpired,
    },
    'shard state loaded',
  );

  shard.start();
  app.log.info({ systemId: simSystem.systemId, name: simSystem.name }, 'shard started (20 Hz)');

  // 30 s flush cadence (PRD §8): one small transaction per flush, unref'd so
  // it never holds the process open; failures log and retry next tick.
  const stopFlushing = startShardFlushTimer({
    intervalMs: env.SHARD_FLUSH_INTERVAL_MS,
    flush: () => shardPersist.flushShips(shard),
    log: {
      debug: (msg, meta) => app.log.debug(meta, msg),
      warn: (msg, meta) => app.log.warn(meta, msg),
      info: (msg, meta) => app.log.info(meta, msg),
    },
  });

  registerApiRoutes(app, { repo, sessions, galaxySeed: env.GALAXY_SEED, shipSwapBus });
  const wsHandle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway,
    authenticate: createTokenAuthenticate(sessions),
    revokeToken: (token) => sessions.revoke(token),
    onGameMessage: (conn, type, payload) => {
      // WS 'input' handler: enqueue for the shard; the tick drains it.
      if (type === 'input' && conn.systemId === simSystem.systemId && conn.playerId) {
        shard.enqueueInput(conn.playerId, payload as Parameters<SystemShard['enqueueInput']>[1]);
      }
    },
    onJoinSystem: async (conn, systemId) => {
      if (systemId === simSystem.systemId) await shard.join(conn);
    },
    onLeaveSystem: (conn, systemId) => {
      if (systemId === simSystem.systemId) shard.leave(conn);
    },
  });
  // TASK-20: dock purchases swap the ship entity in-place for any peer in-system.
  attachShipSwapBroadcast(shipSwapBus, wsHandle.connections, repo);

  // TASK-24: graceful shutdown — stop ticking, run the FINAL flush (so a
  // SIGTERM loses nothing), then close cleanly with exit code 0.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'graceful shutdown: flushing shard');
    stopFlushing();
    shard.stop();
    try {
      const summary = await shardPersist.flushShips(shard);
      app.log.info(summary, 'final shard flush');
    } catch (err) {
      app.log.error({ err }, 'final shard flush failed');
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
}

void main();
