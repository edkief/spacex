import { loadEnv } from '@server/env';
import { buildServer } from '@server/server';
import { attachWebSocket, createRegistryGateway } from '@server/ws';
import { getDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { pgTables, sqliteTables } from '@server/db/schema';

const env = loadEnv();
const app = buildServer(env);

const dbHandle = getDb();
const gateway = createRegistryGateway(
  createRepo(dbHandle.db, dbHandle.driver === 'sqlite' ? sqliteTables : pgTables),
);

attachWebSocket(app, { path: env.WS_PATH, gateway });

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
