import path from 'node:path';
import { buildServer } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { openDatabase } from './db/open.ts';
import { createGalaxyDirectory } from './directory.ts';
import { findAppDir, loadAppEnv } from './env.ts';

/** Loads config, starts the server and wires graceful shutdown. Exits 1 on invalid config. */
async function main(): Promise<void> {
  const appDir = findAppDir(import.meta.dirname);
  let config;
  try {
    config = loadConfig(loadAppEnv(appDir));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const staticDir = config.isProduction ? path.join(appDir, 'dist', 'client') : undefined;
  const database = await openDatabase(config, { appDir });
  const app = buildServer(
    {
      config,
      repo: database.repo,
      directory: createGalaxyDirectory({ seed: config.galaxySeed }),
    },
    staticDir ? { staticDir } : {},
  );

  // Shutdown order: sockets (preClose hook), then the HTTP server, then the database.
  const shutdown = (): void => {
    void app
      .close()
      .then(() => database.close())
      .then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: config.host, port: config.listenPort });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
