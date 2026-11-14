import path from 'node:path';
import { buildServer } from './app.ts';
import { denyAllAuthenticator } from './auth/types.ts';
import { ConfigError, loadConfig } from './config.ts';
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
  const app = buildServer(
    {
      config,
      authenticator: denyAllAuthenticator,
      directory: createGalaxyDirectory({ seed: config.galaxySeed }),
    },
    staticDir ? { staticDir } : {},
  );

  const shutdown = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: config.host, port: config.listenPort });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
