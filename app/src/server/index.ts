/**
 * Drift server entry point.
 *
 * Reads config from `.env.local`, boots the whole server through
 * {@link startRuntime} (DB + Fastify + WS + galaxy router + shard
 * flush service — see `./runtime.ts`), and installs the SIGINT /
 * SIGTERM handlers. `tsx watch` invokes this file during
 * `npm run dev`; production launches it via `node dist/server/index.js`
 * (TASK-69).
 *
 * The TASK-18 load harness boots the *same* `startRuntime` with a
 * temp-file SQLite DB and a random port, so what it measures is the
 * real boot path.
 */
import { serverConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { assertValidSecret } from "./auth/token.js";
import { DEFAULT_SHUTDOWN_WATCHDOG_MS } from "@shared/galaxy/constants.js";

async function main(): Promise<void> {
  // The token codec requires a real SESSION_SECRET. Refuse to boot if
  // it's missing or too short — silent fallback would ship a
  // forgeable auth path.
  assertValidSecret(serverConfig.sessionSecret);

  const runtime = await startRuntime({ config: serverConfig });

  runtime.app.log.info(
    {
      port: runtime.port,
      wsPath: serverConfig.wsPath,
      clientPort: serverConfig.port,
    },
    "drift server listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    runtime.app.log.info({ signal }, "shutting down");
    // TASK-12: install a watchdog so a misbehaving flush can't hang
    // the process forever. Kubernetes' default
    // terminationGracePeriodSeconds is 30 s, but 10 s is plenty for a
    // 16-shard flush and gives us a log line before force-exiting.
    const watchdog = setTimeout(() => {
      runtime.app.log.error(
        { signal, watchdogMs: DEFAULT_SHUTDOWN_WATCHDOG_MS },
        "shutdown watchdog fired — force exiting with code 1",
      );
      process.exit(1);
    }, DEFAULT_SHUTDOWN_WATCHDOG_MS);
    if (typeof watchdog.unref === "function") watchdog.unref();
    try {
      runtime.app.log.info({ signal }, "flushing shards before shutdown");
      await runtime.close();
    } finally {
      clearTimeout(watchdog);
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  // Surface the error then exit with a non-zero code so `tsx watch` respawns.
  console.error("[drift-server] fatal:", err);
  process.exit(1);
});
