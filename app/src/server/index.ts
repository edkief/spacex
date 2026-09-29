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
import { SystemShard } from '@server/shard';

const env = loadEnv();
const app = buildServer(env);

/**
 * Process entry. TASK-13 runs one test-only shard (the seed's first star
 * system) until the router (TASK-11) creates/reaps shards per system.
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
  const shard = new SystemShard({
    systemId: simSystem.systemId,
    galaxySeed: env.GALAXY_SEED,
    system: simSystem,
    repo,
    shipSwapBus,
    persist: (entities) => {
      // v1: log-only save hook (the persistence service wires in TASK-12/24).
      app.log.debug({ count: entities.length }, 'shard persist (no-op)');
    },
  });
  shard.start();
  app.log.info({ systemId: simSystem.systemId, name: simSystem.name }, 'shard started (20 Hz)');

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

  await app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

void main();
