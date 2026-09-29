import { loadEnv } from '@server/env';
import { buildServer } from '@server/server';
import { attachWebSocket, createRegistryGateway } from '@server/ws';
import { getDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { pgTables, sqliteTables } from '@server/db/schema';
import { createSessionService, createTokenAuthenticate } from '@server/auth/session';
import { createTokenCodec } from '@server/auth/token';
import { registerApiRoutes } from '@server/routes';

const env = loadEnv();
const app = buildServer(env);

const dbHandle = getDb();
const repo = createRepo(dbHandle.db, dbHandle.driver === 'sqlite' ? sqliteTables : pgTables);
const sessions = createSessionService({ repo, codec: createTokenCodec(env.SESSION_SECRET) });
const gateway = createRegistryGateway(repo);

registerApiRoutes(app, { repo, sessions, galaxySeed: env.GALAXY_SEED });
attachWebSocket(app, {
  path: env.WS_PATH,
  gateway,
  authenticate: createTokenAuthenticate(sessions),
  revokeToken: (token) => sessions.revoke(token),
});

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
